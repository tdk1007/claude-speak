export type Speaking = boolean

declare module 'claude-code' {
  interface PluginState {
    speak: {
      lastAnswer: string
      isSpeaking: boolean
      isConversation: boolean
      pendingSpeech: string
      currentEngine: string
      turnEndedAt: number
      readStartedAt: number
      installed: string
      setupStep: string
    }
  }
}
