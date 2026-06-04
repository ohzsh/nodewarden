import { handleEdgeOnePagesRequest } from '../_generated/edgeone-handler.mjs';

export default function onRequest(context) {
  return handleEdgeOnePagesRequest(context);
}
