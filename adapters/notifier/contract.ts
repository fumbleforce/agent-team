// A way to reach the owner outside the app. One message is a title, a few lines and where to act on it; `urgent` asks the channel to
// make itself noticed (a sound on a phone). A failure throws with a short reason that never carries the credential or the response body.
export interface Notice { title: string; body: string; url?: string | null; urgent?: boolean }
export interface Notifier { send(notice: Notice): Promise<void> }
export interface NotifierField { key: string; label: string; placeholder?: string; help?: string; required?: boolean; pattern?: string; suggest?: () => string }
// What the app shows when a notifier is set up: the product's words, its fields, and the credential it may take, kept sealed.
export interface NotifierEntry {
  kind: string; title: string; summary: string; steps: string[]; fields: NotifierField[];
  credential: { variable: string; label: string; optional: boolean; placeholder?: string } | null;
  create(values: Record<string, string>, token: string | null, request: typeof fetch): Notifier;
}
