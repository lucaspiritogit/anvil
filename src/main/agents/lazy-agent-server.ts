interface AgentServer {
  failure: Promise<never>
  fail(error: Error): void
  close(): Promise<void>
}

/** Shares startup across concurrent turns and cleans up broken servers before shutdown. */
export class LazyAgentServer<Connection extends AgentServer> {
  private current?: { connection: Connection; ready: Promise<Connection> }
  private retiring = new Set<Promise<void>>()
  private shutdown?: Promise<void>

  get(create: () => Connection, initialize: (connection: Connection) => Promise<void>): Promise<Connection> {
    if (this.shutdown) return Promise.reject(new Error('Agent server is shutting down'))
    if (this.current) return this.current.ready
    const connection = create()
    const ready = initialize(connection).then(() => connection, (failure: unknown) => {
      connection.fail(failure instanceof Error ? failure : new Error(String(failure)))
      throw failure
    })
    this.current = { connection, ready }
    void connection.failure.catch(() => {
      if (this.current?.connection === connection) this.current = undefined
      const closing = connection.close()
      this.retiring.add(closing)
      // Keep failed cleanup tracked so close() reports it instead of silently exiting.
      void closing.then(() => this.retiring.delete(closing), () => {})
    })
    return ready
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown
    // Set the shutdown guard before close() rejects in-flight requests.
    this.shutdown = Promise.resolve().then(async () => {
      const connection = this.current?.connection
      this.current = undefined
      await Promise.all([...this.retiring, ...(connection ? [connection.close()] : [])])
    })
    return this.shutdown
  }
}
