import { api } from './api.js';

export const CHUNK_SIZE = 2 * 1024 * 1024;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const formats = {jpg:['image','image/jpeg'], jpeg:['image','image/jpeg'], png:['image','image/png'],
  webp:['image','image/webp'], mp4:['video','video/mp4'], mov:['video','video/quicktime']};

export function fileDetails(file) {
  const format = formats[file.name.split('.').at(-1).toLowerCase()];
  if (!format || (file.type && file.type !== format[1])) throw new Error('Choose a JPG, PNG, WebP, MP4, or MOV file.');
  if (!file.size || file.size > (format[0] === 'image' ? 10 : 50) * 1024 * 1024)
    throw new Error('Images can be up to 10 MB and videos up to 50 MB. Choose a smaller file.');
  if (file.name.length > 180 || /[\x00-\x1f/\\]/.test(file.name)) throw new Error('Use a filename of up to 180 characters without slashes.');
  return {name:file.name, type:format[0], mime:format[1], size:file.size, parts:Math.ceil(file.size / CHUNK_SIZE)};
}

const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const encode = bytes => {
  let text = '';
  for (let i=0;i<bytes.length;i+=8192) text += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
};

export async function uploadFile(file, id, onProgress, signal) {
  const details = fileDetails(file);
  if (!idPattern.test(id)) throw new Error('Choose the file again.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const manifest = {id,...details,sha256:await hash(bytes)};
  for (let index=0;index<details.parts;index++) {
    signal?.throwIfAborted();
    await api(`/uploads/${id}/parts/${index}`, {method:'PUT',signal,
      body:JSON.stringify({content:encode(bytes.subarray(index*CHUNK_SIZE,(index+1)*CHUNK_SIZE))})});
    onProgress(Math.round((index+1)/details.parts*100));
  }
  await api(`/uploads/${id}`, {method:'POST',signal,body:JSON.stringify(manifest)});
  return manifest;
}

export async function downloadUpload(source, signal) {
  const details = fileDetails({name:source.name,type:source.mime,size:source.size});
  if (!idPattern.test(source.upload_id) || source.parts !== details.parts) throw new Error('This uploaded file could not be opened.');
  const bytes = new Uint8Array(details.size);
  for (let index=0;index<details.parts;index++) {
    const part = await api(`/uploads/${source.upload_id}/parts/${index}`, {signal});
    const decoded = Uint8Array.from(atob(part.content),c=>c.charCodeAt(0));
    if (decoded.length !== Math.min(CHUNK_SIZE,details.size-index*CHUNK_SIZE)) throw new Error('This uploaded file is incomplete.');
    bytes.set(decoded,index*CHUNK_SIZE);
  }
  if (await hash(bytes) !== source.sha256) throw new Error('This uploaded file does not match the saved post.');
  return new Blob([bytes],{type:details.mime});
}
