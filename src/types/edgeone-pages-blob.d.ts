declare module '@edgeone/pages-blob' {
  import type { EdgeOneBlobStore } from '../services/storage-edgeone-blob';

  export function getStore(name: string | { name: string; consistency?: 'eventual' | 'strong' }): EdgeOneBlobStore;
  export function listStores(options?: {
    projectId?: string;
    token?: string;
    consistency?: 'eventual' | 'strong';
  }): Promise<{ stores: Array<{ name: string }> }>;
}
