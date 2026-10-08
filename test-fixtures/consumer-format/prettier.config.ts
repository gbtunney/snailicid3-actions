// The Prettier config every Snailicid3 consumer formats with. Synced caller
// workflows are committed through that formatter, so a template it rewrites
// drifts in every consumer the moment it is committed.
import { Prettier } from '@snailicid3/config'

export default Prettier.config({ cwd: import.meta })
