import { defineWeb, useApi } from "@pipoca/plugins/web";
import { Button, Page } from "@pipoca/ui";
import { useState } from "react";
import { greeter } from "../plugin";

function Greeter() {
  const api = useApi(greeter);
  const [greeting, setGreeting] = useState("");

  const greet = async () => {
    const body = await api.get<{ greeting: string }>("greeting");

    setGreeting(body.greeting);
  };

  return (
    <Page title="Greeter" description="An example plugin." className="gap-4">
      <Button onClick={() => void greet()}>Greet me</Button>
      <p>{greeting}</p>
    </Page>
  );
}

export const web = defineWeb(greeter, {
  pages: [{ path: "", label: "Greeter", Page: Greeter, nav: {} }],
  settings: { group: "server", form: "auto" },
});
