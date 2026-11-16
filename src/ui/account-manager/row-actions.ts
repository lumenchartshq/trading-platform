import type { ActionMetaInfo, Order, OrderStatus } from "../../contracts/broker.js";
import type { EntityReader } from "../../core/entity-store.js";
import type { TradingSession } from "../../core/session.js";
import { terminalStatuses } from "../../core/entity-validation.js";
import { canModifyOrder } from "../../core/order-modification.js";
import type { AccountPage } from "./account-pages.js";
import type { createRowActionTracker } from "./row-action-tracker.js";

export type PositionRowAction = "close" | "reverse" | "protect";
export type AccountTableRow = {
  id: string;
  symbol?: string;
  [key: string]: unknown;
};
export interface AccountTableAction {
  readonly id: string;
  readonly label: string;
  readonly tooltip?: string;
  readonly visible?: (row: Readonly<AccountTableRow>) => boolean;
  readonly disabled?: (row: Readonly<AccountTableRow>) => boolean;
  readonly run: (row: Readonly<AccountTableRow>) => void;
}

/** Both inline and menu commands resolve their entity and permissions at activation. */
export function createAccountRowActions(props: {
  session: TradingSession;
  connection: TradingSession["state"]["connection"]["get"];
  pendingRows(): ReadonlySet<string>;
  policy: TradingSession["policy"]["get"];
  symbolOptions(): number;
  tracker: ReturnType<typeof createRowActionTracker>;
  onOrderAction?: (id: string) => void;
  onPositionAction?: (id: string, individual: boolean, action: PositionRowAction) => Promise<void>;
}) {
  async function cancelOrder(row: Readonly<AccountTableRow>) {
    const context = props.session.commands.context(row.id);
    await props.tracker.run(row.id, context, async status => {
      await props.session.host.showCancelOrderDialog(row.id, async () => {
        const result = await props.session.commands.cancel({ id: row.id, context });
        if (result.outcome === "unconfirmed") status("Cancellation is unconfirmed. Refresh to check the order.");
        else if (result.outcome === "changed") status("The order changed before cancellation was confirmed. Review its current status.");
        else status("Order cancelled.");
      });
    }, "The order could not be cancelled.");
  }
  function actions(kind: AccountPage["actions"]): readonly AccountTableAction[] {
    const disabled = (row: Readonly<AccountTableRow>) =>
      props.connection().phase !== "ready" || props.pendingRows().has(row.id);
    if (kind === "orders") {
      const visible = (row: Readonly<AccountTableRow>) =>
        !terminalStatuses.has(row.status as OrderStatus);
      const actions: AccountTableAction[] = [
        {
          id: "cancel",
          label: "Cancel",
          visible,
          disabled,
          run: (row) => {
            void cancelOrder(row);
          },
        },
      ];
      if (props.onOrderAction)
        actions.unshift({
          id: "modify",
          label: "Modify",
          tooltip: "Modify Order…",
          visible: (row) => {
            props.policy();
            // Order rows are the store's order entities; no second lookup.
            return visible(row) && canModifyOrder(props.session.orderEditability(row as unknown as Readonly<Order>));
          },
          disabled,
          run: (row) => props.onOrderAction?.(row.id),
        });
      return actions;
    }
    if (
      (kind === "positions" || kind === "individual") &&
      props.onPositionAction
    ) {
      const individual = kind === "individual";
      const flags = props.policy().flags;
      const run = (
        row: Readonly<AccountTableRow>,
        action: PositionRowAction,
      ) => {
        const context = props.session.commands.context(
          row.id,
          individual ? "individualPosition" : "position",
        );
        void props.tracker.run(row.id, context,
          async () => props.onPositionAction?.(row.id, individual, action),
          "The position could not be updated.",
        );
      };
      const actions: AccountTableAction[] = [];
      // Symbol options may enable or disable reversing per instrument, so each row decides.
      if (!individual)
        actions.push({
          id: "reverse",
          label: "Reverse",
          tooltip: "Reverse Position…",
          disabled,
          // Symbol-specific options may turn reversing off for one instrument.
          visible: (row) =>
            props.symbolOptions() >= 0 &&
            props.session.symbolPolicy(row.symbol).flags.supportReversePosition,
          run: (row) => run(row, "reverse"),
        });
      if (
        individual
          ? flags.supportIndividualPositionBrackets
          : flags.supportPositionBrackets
      )
        actions.push({
          id: "protect",
          label: "Protection",
          tooltip: "Protect Position…",
          disabled,
          visible: (row) =>
            props.session.symbolPolicy(row.symbol).symbol
              .supportModifyPositionBrackets !== false,
          run: (row) => run(row, "protect"),
        });
      if (
        individual
          ? flags.supportCloseIndividualPosition
          : flags.supportClosePosition || flags.supportMarketOrders
      )
        actions.push({
          id: "close",
          label: "Close",
          disabled,
          run: (row) => run(row, "close"),
        });
      return actions;
    }
    return [];
  }

  return {
    bind(reader: EntityReader<AccountTableRow>, kind: AccountPage["actions"], isCurrent: () => boolean) {
      const available = () => actions(kind);
      const visible = (action: AccountTableAction, row: Readonly<AccountTableRow>) =>
        !action.visible || action.visible(row);
      const run = (rowId: string, actionId: string) => {
        if (!isCurrent()) return;
        const row = reader.get(rowId);
        const action = available().find(item => item.id === actionId);
        if (row && action && visible(action, row) && !action.disabled?.(row)) action.run(row);
      };
      return {
        actions: available,
        isCurrent,
        run,
        menu(rowId: string): ActionMetaInfo[] | undefined {
          if (!isCurrent()) return;
          const row = reader.get(rowId);
          if (!row) return;
          return available().filter(action => visible(action, row)).map(action => ({
            text: action.label,
            enabled: !action.disabled?.(row),
            action: () => run(rowId, action.id),
          }));
        },
      };
    },
  };
}
