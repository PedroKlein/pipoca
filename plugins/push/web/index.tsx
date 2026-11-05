import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, ErrorText, PageTitle, Row, Rows } from "@pipoca/ui";
import { type ReactElement, useState } from "react";

export const push: WebPlugin = {
  name: "push",
  SettingsSection,
};

const supported =
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof PushManager !== "undefined";

function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const [error, setError] = useState<string>();

  const key = useLoaded(
    async () => (await json<{ key: string }>(context.request("key"))).key,
    "push.key",
  ).value;

  const { value: current, reload } = useLoaded(
    async () =>
      (
        await navigator.serviceWorker.getRegistration("/")
      )?.pushManager.getSubscription() ?? null,
    "push.subscription",
  );

  if (!supported) {
    return null;
  }

  // Safari asks for permission only from a click, so subscribing starts
  // with nothing awaited before it but the service worker.
  const turnOn = async (): Promise<void> => {
    if (key === undefined) {
      return;
    }

    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });

    await json(
      context.request("subscriptions", {
        method: "PUT",
        body: JSON.stringify(subscription.toJSON()),
      }),
    );
  };

  const turnOff = async (subscription: PushSubscription): Promise<void> => {
    await json(
      context.request("subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }),
    );

    await subscription.unsubscribe();
  };

  const run = (action: () => Promise<void>): void => {
    setError(undefined);

    action().then(reload, (reason: unknown) => {
      setError(
        Notification.permission === "denied"
          ? "Notifications are blocked for Pipoca in this browser's settings."
          : String(reason),
      );

      reload();
    });
  };

  return (
    <>
      <PageTitle description="Where Pipoca tells you that Pi finished or needs you, even with Pipoca closed.">
        Notifications
      </PageTitle>
      <Rows>
        <Row
          title="This device"
          description={
            current
              ? "Gets a notification when Pi finishes or needs you."
              : "On an iPhone, add Pipoca to the Home Screen first."
          }
        >
          {current ? (
            <Button
              onClick={() => {
                run(async () => turnOff(current));
              }}
            >
              Turn off on this device
            </Button>
          ) : (
            <Button
              disabled={key === undefined || current === undefined}
              onClick={() => {
                run(turnOn);
              }}
            >
              Turn on for this device
            </Button>
          )}
        </Row>
      </Rows>
      <ErrorText size="caption" className="mt-2">
        {error}
      </ErrorText>
    </>
  );
}
