// An open vote as one person sees it: who picked what, their own pick, and
// whether they may close it.
export interface Vote {
  readonly id: string;
  readonly opener: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly picks: readonly {
    readonly person: string;
    readonly name: string;
    readonly option: string;
  }[];
  readonly mine: string | null;
  readonly canClose: boolean;
  readonly closesAt: string;
}

export interface Votes {
  readonly canOpen: boolean;
  readonly votes: readonly Vote[];
}
