// Facebook Graph API publishing. Mirrors facebook.py and MediaService.video_status.
import { WorkflowError } from './drive.js';

const graph = config => `https://graph.facebook.com/${config.fb_graph_version}`;

async function send(url, body, timeout, label = 'post') {
  const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(timeout) });
  // safe_error extracts only the numeric provider code from this text.
  if (!response.ok) throw new WorkflowError(`Facebook ${label} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

/** Share the publisher's article/video and its Facebook link preview. */
export function postLink(config, link, message) {
  const body = new URLSearchParams({ message, link, access_token: config.fb_page_access_token });
  return send(`${graph(config)}/${config.fb_page_id}/feed`, body, 60000);
}

export function postPhoto(config, bytes, message) {
  const body = new FormData();
  body.set('message', message);
  body.set('access_token', config.fb_page_access_token);
  body.set('source', new Blob([bytes]), 'image.jpg');
  return send(`${graph(config)}/${config.fb_page_id}/photos`, body, 60000);
}

export function postVideo(config, bytes, message) {
  const body = new FormData();
  body.set('description', message);
  body.set('access_token', config.fb_page_access_token);
  body.set('source', new Blob([bytes]), 'video.mp4');
  return send(`https://graph-video.facebook.com/${config.fb_graph_version}/${config.fb_page_id}/videos`, body, 300000, 'video post');
}

export async function videoStatus(config, videoId) {
  const url = new URL(`${graph(config)}/${videoId}`);
  url.searchParams.set('fields', 'id,permalink_url,status');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${config.fb_page_access_token}` },
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Facebook status request failed (${response.status}).`);
  return response.json();
}
