const assert = require('node:assert/strict')

module.exports = async function exerciseBranchNaming(client) {
  const { tools } = await client.listTools()
  const tool = tools.find((entry) => entry.name === 'anvil_set_task_branch')
  assert.deepEqual(tool.inputSchema.required, ['branchName'])
  assert.equal(tool.inputSchema.additionalProperties, false)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, JSON.stringify(result))
    return JSON.parse(result.content[0].text)
  }
  const { task } = await call('anvil_get_plan')
  if (!task.branchName) return
  if (task.canNameBranch) {
    const result = await call(tool.name, { branchName: 'feat/protocol-selected-name' })
    assert.equal(result.branchName, 'feat/protocol-selected-name')
    assert.equal(result.canNameBranch, false)
  }
  assert.equal((await call(tool.name, { branchName: 'feat/protocol-selected-name' })).branchName, 'feat/protocol-selected-name')
  const after = (await call('anvil_get_plan')).task
  assert.equal(after.branchName, 'feat/protocol-selected-name')
  assert.equal(after.canNameBranch, false)
  assert.equal(after.title, task.title)
}
