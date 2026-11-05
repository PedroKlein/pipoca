import type { Account } from "@pipoca/protocol";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  Row,
  Rows,
  Section,
  Select,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../../api";
import { useEnvironments, useProfiles } from "../../hooks";

export function EditProfile({
  account,
}: {
  readonly account: Account | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  const close = (): void => {
    setOpen(false);
    setError(undefined);
  };

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("displayName");

    api("me.update", {
      body: { displayName: typeof name === "string" ? name : "" },
    }).then(close, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <>
      <Button
        disabled={account === undefined}
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit profile
      </Button>
      <Dialog open={open} onClose={close} title="Edit profile" size="sm">
        <form onSubmit={save}>
          <DialogBody>
            <Field
              label="Your name"
              hint={`People see it beside your username, @${account?.name ?? ""}.`}
            >
              <TextInput
                name="displayName"
                autoComplete="name"
                maxLength={64}
                defaultValue={account?.displayName ?? ""}
              />
            </Field>
            <ErrorText size="caption">{error}</ErrorText>
          </DialogBody>
          <DialogFoot>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit">
              Save
            </Button>
          </DialogFoot>
        </form>
      </Dialog>
    </>
  );
}

// What a Session starts with when the person doesn't pick. The model comes
// from the Profile (ADR 0063).
export function StartWith({
  account,
}: {
  readonly account: Account | undefined;
}): ReactElement {
  const environments = useEnvironments().value;
  const profiles = useProfiles().value;
  const [error, setError] = useState<string>();

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const chosen = environments.some(
    ({ id }) => id === account?.defaultEnvironment,
  )
    ? (account?.defaultEnvironment ?? "")
    : "";

  return (
    <Section title="New Sessions start with">
      <Rows>
        <Row
          title="Environment"
          description="Where a Session runs when you don't pick one"
        >
          <Select
            aria-label="Environment"
            value={chosen}
            disabled={account === undefined}
            onChange={(event) => {
              const picked = event.target.value;

              api("me.update", {
                body: { defaultEnvironment: picked === "" ? null : picked },
              }).then(() => {
                setError(undefined);
              }, failed);
            }}
          >
            <option value="">
              {environments[0] === undefined
                ? "None yet"
                : `The first, ${environments[0].name}`}
            </option>
            {environments.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          title="Profile"
          description="Its providers decide which models a Session can pick"
        >
          <Select
            aria-label="Profile"
            value={profiles.find(({ isDefault }) => isDefault)?.id ?? ""}
            onChange={(event) => {
              api("profiles.update", {
                params: { id: event.target.value },
                body: { isDefault: true },
              }).then(() => {
                setError(undefined);
              }, failed);
            }}
          >
            {profiles.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Row>
      </Rows>
      <ErrorText size="caption">{error}</ErrorText>
    </Section>
  );
}

export function SignOutEverywhere(): ReactElement {
  const [ask, asking] = useConfirm();

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          void ask({
            title: "Sign out everywhere?",
            description:
              "Every browser and app signed in as you signs out, and your access tokens stop working.",
            confirm: "Sign out everywhere",
            danger: true,
          }).then((yes) => {
            if (yes) {
              void api("me.signIns.remove").finally(() => {
                location.replace("/");
              });
            }
          });
        }}
      >
        Sign out everywhere
      </Button>
      {asking}
    </>
  );
}
