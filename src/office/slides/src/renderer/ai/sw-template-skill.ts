/** Native, local PowerPoint creation. No HTML slides, external images, or cloud generator. */
import type { AgentSkill } from '@genoffice/agent-core'
import { SLIDE_STYLES, SLIDE_LAYOUTS, buildTemplateSlide, validateDeck, type TemplateDeck } from '../../shared/sw-library'
import type { DeckAccess } from './slides-skill'
import { auditSlideLayout } from './layout-audit'

export async function createLocalPresentation(access: DeckAccess, value: unknown, signal?: AbortSignal) {
  const deck = validateDeck(value)
  if (!access.landGeneratedPages) throw new Error('The local presentation service is not ready.')
  const before = JSON.stringify(access.getSlides())
  const markers: string[] = []
  for (let i = 0; i < deck.slides.length; i++) {
    signal?.throwIfAborted()
    const spec = buildTemplateSlide(deck.slides[i], deck.styleId, i + 1, deck.slides.length)
    const result = await window.slidesApi.localGeneratePage({ specJson: JSON.stringify(spec) })
    if (!result.ok || !result.marker) throw new Error(result.error || `Slide ${i + 1} could not be created. No slides were applied.`)
    markers.push(result.marker)
  }
  signal?.throwIfAborted()
  if (JSON.stringify(access.getSlides()) !== before) throw new Error('The presentation changed while preparing slides. Run the request again; no slides were applied.')
  const result = await access.landGeneratedPages(markers, deck.mode, deck.title)
  if (!result.ok) throw new Error(result.error || 'The new slides could not be inserted.')
  const slides = access.getSlides(), first = deck.mode === 'replace' ? 0 : (result.appendedFrom ?? Math.max(0, slides.length - markers.length))
  const issues = slides.slice(first, first + markers.length).flatMap((s, i) => auditSlideLayout(s).map(x => `Slide ${first + i + 1}: ${x}`))
  return { created: markers.length, total: result.pages ?? slides.length, issues, fallback: result.fallbackReason }
}
export function createTemplateSkill(access: DeckAccess): AgentSkill {
  return {
    id: 'native-templates', systemPrompt: '',
    tools: [
      {name:'list_slide_templates',description:'List the local slide styles, layouts, and exact content limits before creating a presentation.',inputSchema:{type:'object',properties:{}}},
      {name:'audit_layout',description:'Inspect actual rendered slides for text overflow, content collisions, and off-slide elements. A clean geometry result does not establish factual accuracy.',inputSchema:{type:'object',properties:{slideIndex:{type:'integer',minimum:0}}}},
      {name:'create_presentation',description:'Create 1–20 editable native slides using the local library. All content is validated before any slides are applied. Usually append; replace only when explicitly requested or starting a blank deck. Call list_slide_templates first. Use concise supplied/source-supported content; never invent data to fill a layout.',inputSchema:{type:'object',properties:{title:{type:'string'},styleId:{type:'string',enum:SLIDE_STYLES.map(s=>s.id)},mode:{type:'string',enum:['append','replace']},slides:{type:'array',minItems:1,maxItems:20,items:{type:'object',properties:{layout:{type:'string',enum:SLIDE_LAYOUTS.map(s=>s.id)},title:{type:'string'},subtitle:{type:'string'},footer:{type:'string'},items:{type:'array',items:{type:'object',properties:{heading:{type:'string'},text:{type:'string'}},required:['heading','text'],additionalProperties:false}}},required:['layout','title'],additionalProperties:false}}},required:['title','styleId','mode','slides'],additionalProperties:false}},
    ],
    async executeTool(call, signal) {
      try {
        if(call.name==='list_slide_templates') return {mutated:false,summary:'Read slide library',output:JSON.stringify({styles:SLIDE_STYLES.map(({id,name})=>({id,name})),layouts:SLIDE_LAYOUTS,limits:{title:110,subtitle:180,footer:100,coverSectionClosing:'No items',content:'1–3 items; heading 70, body 280 characters',twoColumnComparison:'Exactly 2 items; heading 70, body 360',threeColumn:'Exactly 3 items; heading 70, body 220',timelineProcess:'1–5 items; heading 42, body 160. Prefer 60–90 characters for narrow process cards.'}})}
        if(call.name==='audit_layout') {const index=call.input.slideIndex;if(index!==undefined&&(!Number.isInteger(index)||Number(index)<0||Number(index)>=access.getSlides().length))throw new Error('Choose an existing zero-based slideIndex.');const issues=access.getSlides().flatMap((s,i)=>index!==undefined&&i!==index?[]:auditSlideLayout(s).map(x=>`Slide ${i+1}: ${x}`));return{mutated:false,summary:issues.length?`${issues.length} layout findings`:'Layout checked',output:JSON.stringify({issues,scope:index??'deck'})}}
        if(call.name!=='create_presentation') throw new Error('Unknown template operation.')
        const result=await createLocalPresentation(access,call.input as unknown as TemplateDeck,signal)
        return{mutated:true,summary:`Created ${result.created} editable slides`,output:JSON.stringify(result)}
      }catch(error){return{isError:true,summary:'Presentation operation stopped',output:error instanceof Error?error.message:'The operation could not complete.'}}
    },
  }
}
