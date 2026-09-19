const { signAsync } = require('@electron/osx-sign')

module.exports = async function signMacApp(options) {
  await signAsync({
    ...options,
    identity: 'Anvil Self-Signed',
    identityValidation: false,
    keychain: undefined,
    timestamp: 'none'
  })
}
