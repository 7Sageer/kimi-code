export interface SpineNode {
  readonly id: string;
  readonly summary: string;
  readonly openedAt: number;
  readonly closedAt?: number;
  readonly memory?: string;
  readonly children: readonly string[];
}

export interface SpineState {
  readonly nodes: Readonly<Record<string, SpineNode>>;
  readonly openStack: readonly string[];
  readonly rootEpoch: number;
  readonly epochStartAt: number;
  readonly epochMemoryAt?: number;
}
