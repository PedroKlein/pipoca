import { createContext } from "react";

// The signed-in user, for what only they or an admin may do.
export const Me = createContext<{
  readonly id: string;
  readonly admin: boolean;
}>({ id: "", admin: false });
