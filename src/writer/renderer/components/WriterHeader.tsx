export {WebWriterHeader as WriterHeader} from '../../web/WriterHeader';
export function WriterMark({size=20}:{size?:number}){
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4H5a2 2 0 0 0-2 2v14h14a2 2 0 0 0 2-2v-7"/><path d="m10 14 1-4 8-8 3 3-8 8-4 1Z M17 4l3 3"/></svg>
}
