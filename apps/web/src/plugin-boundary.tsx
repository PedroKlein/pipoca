import { PluginScope } from "@pipoca/plugins/web/shell";
import { Button, ErrorText } from "@pipoca/ui";
import { Component, type ReactNode } from "react";

interface Props {
  readonly name: string;
  readonly children: ReactNode;
}

type State =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown };

// A plugin that throws while rendering shows its error in place instead of
// unmounting the whole app. React only offers this as a class component.
export class PluginBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error };
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return (
        <PluginScope plugin={this.props.name}>
          {this.props.children}
        </PluginScope>
      );
    }

    const { error } = this.state;

    return (
      <ErrorText inline className="inline-flex flex-wrap items-center gap-2">
        The {this.props.name} plugin failed:{" "}
        {error instanceof Error ? error.message : String(error)}
        <Button
          variant="ghost"
          onClick={() => {
            this.setState({ failed: false });
          }}
        >
          Try again
        </Button>
      </ErrorText>
    );
  }
}
