// Which text of the model still belongs on the surface.
//
// When the user speaks over an answer, the voice loop cancels the model. The
// tokens that were already on their way still arrive, after the surface has
// closed the answer. Shown, they open a line of their own (" capital"), and
// in the chat history they glue themselves to the front of the next answer.
// So text counts only from the start of a model response until the user
// speaks again.

export class AnswerGate {
  private cut = false

  /** The user started to speak: what the model still sends is the old answer. */
  userStarted(): void {
    this.cut = true
  }

  /** The model starts a response: its text is the new answer. */
  responseStarted(): void {
    this.cut = false
  }

  accepts(): boolean {
    return !this.cut
  }
}
