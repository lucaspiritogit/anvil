const { homedir } = require('node:os')
const { isAbsolute, join, normalize } = require('node:path')

// Repository maintenance commands default to the development app's data.
const override = process.env.ANVIL_DATA_DIR
if (override && !isAbsolute(override)) throw new Error('ANVIL_DATA_DIR must be an absolute path')
module.exports = override ? normalize(override) : join(homedir(), '.anvil-composer-dev')
