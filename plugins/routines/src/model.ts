export interface WakeUp {
  readonly id: string;
  readonly sessionId: string;
  readonly dueAt: string;
  readonly reason: string;
  readonly message: string;
}
