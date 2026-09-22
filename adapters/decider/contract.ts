// A decider answers typed questions about a piece of state: yes or no, one of a few options, or a level on a scale, each with a
// probability. It is not an engine: it writes no text, runs no turn and holds no seat. The platform asks it what is a
// classification rather than a judgement (what kind of report this is, how hard a task looks) and a seat or a person still
// decides. Every adapter of this kind implements this contract and passes the contract test.

export type Question =
  // The probability that a statement about the state is true.
  | { type: 'noul'; instructions: string }
  // One option of a fixed set; the criteria say what each option means.
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  // A position on an ordered scale of two to ten levels, lowest first.
  | { type: 'score'; instructions: string; criteria: string[] };

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend: Record<string, string> };

// What one call cost: tokens as the model counted them, money in millionths of a dollar so a call that costs a hundredth of a cent is not zero.
export interface Usage { inputTokens: number; outputTokens: number; usdMicro: number }
export interface Decision { model: string; answers: Record<string, Answer>; usage: Usage }

export interface Decider {
  name: string;
  // Whether a call can be made now: a decider that reads its key from the environment says no until one is there.
  ready?(): boolean;
  decide(state: string | object, questions: Record<string, Question>): Promise<Decision>;
}

export class DeciderError extends Error {
  status: number; retryable: boolean;
  constructor(status: number, message: string, retryable = false) { super(message); this.status = status; this.retryable = retryable; }
}

// How sure an answer is, 0 to 1: how far a yes or no is from even, or how much one option or level dominates the rest.
export function confidenceOf(answer: Answer): number {
  return answer.type === 'noul' ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence;
}

// The level a score answer most likely sits on, by its legend.
export function levelOf(answer: Extract<Answer, { type: 'score' }>): string {
  const [index] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0] ?? ['0', 0];
  return answer.legend[index] ?? String(index);
}
