export interface CaffeineState {
  keepAwake: boolean
}

export interface CaffeineActivity {
  subscribe(listener: (state: CaffeineState) => void): () => void
}
