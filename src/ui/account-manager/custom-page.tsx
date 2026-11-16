import { For, Show, onCleanup } from "solid-js";
import type {
  AccountManagerPage,
  AccountManagerTable,
  CustomTableElementFormatter,
} from "../../contracts/broker.js";
import type { TradingEnvironment } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { createCustomTableController } from "./custom-table.js";
import { AccountTable } from "./table.js";
import { TradingButton, useTradingValue } from "../primitives.js";
export type CustomTableController = ReturnType<
  typeof createCustomTableController
>;
/** Controllers created ahead of rendering, e.g. so a page tab can show its row counter. */
export function createPageControllers(
  page: AccountManagerPage,
  session: TradingSession,
): ReadonlyMap<string, CustomTableController> {
  return new Map(
    page.tables.map((table) => {
      const controller = createCustomTableController(table, session.clock);
      void controller.loadNext();
      return [table.id, controller] as const;
    }),
  );
}
/** Total loaded rows across a page's tables, recomputed only when one of them changes. */
export function subscribePageCount(
  controllers: ReadonlyMap<string, CustomTableController>,
  onCount: (count: number) => void,
): () => void {
  const publish = () =>
    onCount(
      [...controllers.values()].reduce(
        (sum, controller) => sum + controller.rows.ids().length,
        0,
      ),
    );
  const releases = [...controllers.values()].map((controller) =>
    controller.rows.subscribeChanges(publish),
  );
  publish();
  return () => releases.forEach((release) => release());
}
function CustomTable(props: {
  table: AccountManagerTable;
  shared?: CustomTableController;
  pageId: string;
  session: TradingSession;
  environment: TradingEnvironment;
  custom?: readonly CustomTableElementFormatter[];
}) {
  const owned = !props.shared;
  const controller =
      props.shared ??
      createCustomTableController(props.table, props.session.clock),
    state = useTradingValue(controller.state);
  if (owned) {
    void controller.loadNext();
    onCleanup(() => controller.destroy());
  }
  return (
    <section aria-label={props.table.title ?? props.table.id}>
      <Show when={props.table.title}>
        <h3>{props.table.title}</h3>
      </Show>
      <AccountTable
        reader={controller.rows}
        columns={props.table.columns}
        session={props.session}
        environment={props.environment}
        custom={props.custom}
        preferenceKey={`custom:${props.pageId}:${props.table.id}`}
        initialSorting={props.table.initialSorting}
        label={props.table.title ?? props.table.id}
      />
      <Show when={state().error}>
        <p role="alert" class="trading-error">
          {state().error}
        </p>
      </Show>
      <Show when={!state().done}>
        <TradingButton
          disabled={state().loading}
          onClick={() => {
            void controller.loadNext();
          }}
        >
          {state().loading ? "Loading…" : "Load more"}
        </TradingButton>
      </Show>
    </section>
  );
}
export function CustomAccountPage(props: {
  page: AccountManagerPage;
  session: TradingSession;
  environment: TradingEnvironment;
  custom?: readonly CustomTableElementFormatter[];
  controllers?: ReadonlyMap<string, CustomTableController>;
}) {
  return (
    <div class="trading-custom-page">
      <For each={props.page.tables}>
        {(table) => (
          <CustomTable
            table={table}
            pageId={props.page.id}
            shared={props.controllers?.get(table.id)}
            session={props.session}
            environment={props.environment}
            custom={props.custom}
          />
        )}
      </For>
    </div>
  );
}
