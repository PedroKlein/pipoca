import { createContext } from "react";

// The signed-in user, for what only they or an admin may do, and whether the
// server has a team besides them.
export const Me = createContext<{
  readonly id: string;
  readonly admin: boolean;
  readonly team: boolean;
}>({ id: "", admin: false, team: false });
