import { createClient } from './client';

export { VERSION, createClient } from './client';
export type { ConsentState, EventProperties, GrowthOSClient, GrowthOSConfig } from './client';

/** Default singleton for `import GrowthOS from "@growthos/sdk"`. */
const GrowthOS = createClient();
export default GrowthOS;
