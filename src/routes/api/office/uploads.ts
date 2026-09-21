import { createFileRoute } from '@tanstack/react-router';

async function upload(request:Request,prepare:boolean) {
  // A per-document engine token cannot create a different Library document.
  if(request.headers.has('authorization'))return Response.json({error:'A browser session is required to create a document.'},{status:403});
  const {officeUser,officeErrorResponse}=await import('@/lib/office/api.server');
  const user=await officeUser(request);if(user instanceof Response)return user;
  try {
    const {readCreateUpload,prepareCreateUpload,commitCreateUpload}=await import('@/lib/office/create-upload.server');
    const input=await readCreateUpload(request);
    const result=prepare?await prepareCreateUpload(user.sub,input):await commitCreateUpload(user.sub,input);
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(error){return officeErrorResponse(error);}
}
export const Route=createFileRoute('/api/office/uploads')({server:{handlers:{
  POST:({request})=>upload(request,true),PUT:({request})=>upload(request,false),
}}});
