import { defineWeb, useApi } from "@pipoca/plugins/web";
import { Button, PageTitle } from "@pipoca/ui";
import { useState } from "react";
import { greeter } from "../plugin";

function Page() {
  const api = useApi(greeter);
  const [greeting, setGreeting] = useState("");

  const greet = async () => {
    const body = await api.get<{ greeting: string }>("greeting");

    setGreeting(body.greeting);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <PageTitle description="An example plugin.">Greeter</PageTitle>
      <Button onClick={() => void greet()}>Greet me</Button>
      <p>{greeting}</p>
    </div>
  );
}

export const web = defineWeb(greeter, {
  pages: [{ path: "", label: "Greeter", Page, nav: {} }],
  settings: { group: "server", form: "auto" },
});
