import { handleEdgeOnePagesRequest } from '../../src/edgeone/handler';

export default function onRequest(context: Parameters<typeof handleEdgeOnePagesRequest>[0]): Promise<Response> {
  return handleEdgeOnePagesRequest(context);
}
