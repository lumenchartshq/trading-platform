/**
 * Broker contracts for the Lumen Charts trading platform: the interface a
 * broker integration implements (`IBrokerTerminal`), the host services it
 * receives (`IBrokerConnectionAdapterHost`) and the order, position,
 * execution and account records they exchange.
 *
 * The shapes follow the widely used broker API surface so existing broker
 * integrations can be connected without changes.
 */
export const enum DisconnectReason {
	SessionRestoreFailed = 0,
	ConnectionLost = 1,
	TokenExpired = 2,
	Inactivity = 3,
	UserLogOut = 4
}
export const enum DisconnectType {
	LogOut = 0,
	FailedRestoring = 1,
	Offline = 2,
	APIError = 3,
	TwoFactorRequired = 4,
	CancelAuthorization = 5,
	TimeOutForAuthorization = 6,
	OauthError = 7,
	BrokenConnection = 8,
	Reconnect = 9,
	FailedSignIn = 10
}
export const enum StandardFormatterName {
	Date = "date",
	DateOrDateTime = "dateOrDateTime",
	Default = "default",
	Fixed = "fixed",
	FixedInCurrency = "fixedInCurrency",
	VariablePrecision = "variablePrecision",
	FormatQuantity = "formatQuantity",
	FormatPrice = "formatPrice",
	FormatPriceForexSup = "formatPriceForexSup",
	FormatExitLevels = "formatExitLevels",
	FormatPriceInCurrency = "formatPriceInCurrency",
	IntegerSeparated = "integerSeparated",
	LocalDate = "localDate",
	LocalDateOrDateTime = "localDateOrDateTime",
	Percentage = "percentage",
	ColoredPercentage = "coloredPercentage",
	Pips = "pips",
	Profit = "profit",
	ProfitInInstrumentCurrency = "profitInInstrumentCurrency",
	ProfitInInstrumentCurrencyFloored = "profitInInstrumentCurrencyFloored",
	ProfitInPercent = "profitInPercent",
	Side = "side",
	PositionSide = "positionSide",
	Status = "status",
	Symbol = "symbol",
	Text = "text",
	Type = "type",
	MarginPercent = "marginPercent",
	Empty = "empty"
}
export enum BottomWidgetBarMode {
	Minimized = "minimized",
	Normal = "normal",
	Maximized = "maximized"
}
export enum CashTransactionType {
	Deposit = "deposit",
	Withdrawal = "withdrawal"
}
export enum CommonAccountManagerColumnId {
	Symbol = "symbol"
}
/** Connection state reported by the broker. */
export enum ConnectionStatus {
	Connected = 1,
	Connecting = 2,
	Disconnected = 3,
	Error = 4
}
export enum ConnectionType {
	Demo = 1,
	Real = 0
}
export enum NotificationType {
	Error = 0,
	Success = 1
}
export enum OrderOrPositionMessageType {
	Information = "information",
	Warning = "warning",
	Error = "error"
}
/** Lifecycle states of an order. */
export enum OrderStatus {
	Canceled = 1,
	Filled = 2,
	Inactive = 3,
	Placing = 4,
	Rejected = 5,
	Working = 6
}
export enum OrderStatusFilter {
	All = 0,
	Canceled = 1,
	Filled = 2,
	Inactive = 3,
	Rejected = 5,
	Working = 6
}
export enum OrderTicketFocusControl {
	LimitPrice = 1,
	StopPrice = 2,
	TakeProfit = 3,
	StopLoss = 4,
	Quantity = 5
}
/** Supported order types. */
export enum OrderType {
	Limit = 1,
	Market = 2,
	Stop = 3,
	StopLimit = 4
}
export enum ParentType {
	Order = 1,
	Position = 2,
	IndividualPosition = 3
}
export enum PriceType {
	Limit = 1,
	Stop = 2
}
/** Buy or sell. */
export enum Side {
	Buy = 1,
	Sell = -1
}
export enum StopType {
	StopLoss = 0,
	TrailingStop = 1,
	GuaranteedStop = 2
}
export interface AccountManagerColumnBase<TFormatterName extends StandardFormatterName | FormatterName, TPossibleFields extends string = string> {
	label: string;
	alignment?: CellAlignment;
	id: string;
	formatter?: TFormatterName;
	dataFields: TFormatterName extends StandardFormatterName ? StandardFormattersDependenciesMapping<TPossibleFields>[TFormatterName] : FieldRef<TPossibleFields>[];
	sortProp?: FieldRef;
	notSortable?: boolean;
	help?: string;
	highlightDiff?: boolean;
	notHideable?: boolean;
	hideByDefault?: boolean;
	tooltipProperty?: string;
	isCapitalize?: boolean;
	showZeroValues?: boolean;
}
/** Layout of the account manager: summary fields, order and position tables, and extra pages. */
export interface AccountManagerInfo {
	accountTitle: string;
	summary: AccountManagerSummaryField[];
	customFormatters?: CustomTableElementFormatter[];
	orderColumns: OrderTableColumn[];
	orderColumnsSorting?: SortingParameters;
	historyColumns?: OrderTableColumn[];
	historyColumnsSorting?: SortingParameters;
	positionColumns?: AccountManagerColumn[];
	individualPositionColumns?: AccountManagerColumn[];
	pages: AccountManagerPage[];
	possibleOrderStatuses?: OrderStatus[];
	contextMenuActions?(contextMenuEvent: MouseEvent | TouchEvent, activePageActions: ActionMetaInfo[]): Promise<ActionMetaInfo[]>;
}
export interface AccountManagerPage {
	id: string;
	title: string;
	tables: AccountManagerTable[];
	displayCounterInTab?: boolean;
}
export interface AccountManagerSummaryField {
	text: string;
	wValue: IWatchedValueReadonly<any>;
	formatter?: StandardFormatterName;
	isDefault?: boolean;
	informerMessage?: string;
}
export interface AccountManagerTable {
	id: string;
	title?: string;
	columns: AccountManagerColumn[];
	initialSorting?: SortingParameters;
	changeDelegate: ISubscription<(data: {}) => void>;
	deleteDelegate?: ISubscription<(id: string) => void>;
	flags?: AccountManagerTableFlags;
	getData(paginationLastId?: string | number): Promise<{}[]>;
}
export interface AccountManagerTableFlags {
	supportPagination?: boolean;
}
export interface AccountMetainfo {
	id: AccountId;
	name: string;
	type?: "live" | "demo";
	currency?: string;
	currencySign?: string;
}
export interface ActionDescription {
	text?: "-" | string;
	separator?: boolean;
	shortcut?: string;
	tooltip?: string;
	checked?: boolean;
	checkedStateSource?: () => boolean;
	checkable?: boolean;
	enabled?: boolean;
	externalLink?: boolean;
	icon?: string;
}
export interface ActionDescriptionWithCallback extends ActionDescription {
	action: (a?: ActionDescription) => void;
}
export interface BaseInputFieldValidatorResult {
	valid: boolean;
}
export interface BracketOrder extends PlacedOrder {
	parentId: string;
	parentType: ParentType;
	exitLevelId?: string;
}
/** Take-profit and stop-loss prices attached to an order or position. */
export interface Brackets {
	stopLoss?: number;
	guaranteedStop?: number;
	takeProfit?: number;
	trailingStopPips?: number;
	exitLevels?: ExitLevel[];
}
/** Feature switches a broker declares, such as brackets, order types and editing support. Unset flags take their default. */
export interface BrokerConfigFlags {
	showQuantityInsteadOfAmount?: boolean;
	supportOrderBrackets?: boolean;
	supportStopLoss?: boolean;
	supportTrailingStop?: boolean;
	supportGuaranteedStop?: boolean;
	supportPositions?: boolean;
	supportPositionBrackets?: boolean;
	supportIndividualPositionBrackets?: boolean;
	supportPositionNetting?: boolean;
	supportClosePosition?: boolean;
	supportCloseIndividualPosition?: boolean;
	supportModifyOrderPrice?: boolean;
	supportEditAmount?: boolean;
	supportModifyBrackets?: boolean;
	supportLevel2Data?: boolean;
	supportMultiposition?: boolean;
	supportPLUpdate?: boolean;
	supportReversePosition?: boolean;
	supportNativeReversePosition?: boolean;
	supportMarketOrders?: boolean;
	supportLimitOrders?: boolean;
	supportStopOrders?: boolean;
	supportStopLimitOrders?: boolean;
	supportDemoLiveSwitcher?: boolean;
	supportMarketBrackets?: boolean;
	supportSymbolSearch?: boolean;
	supportModifyDuration?: boolean;
	supportModifyTrailingStop?: boolean;
	supportMargin?: boolean;
	supportPlaceOrderPreview?: boolean;
	supportModifyOrderPreview?: boolean;
	supportLeverage?: boolean;
	supportLeverageButton?: boolean;
	supportOrdersHistory?: boolean;
	supportAddBracketsToExistingOrder?: boolean;
	supportBalances?: boolean;
	closePositionCancelsOrders?: boolean;
	supportOnlyPairPositionBrackets?: boolean;
	supportOnlyPairOrderBrackets?: boolean;
	supportCryptoExchangeOrderTicket?: boolean;
	supportSymbolSpecificCryptoOrderTicket?: boolean;
	positionPLInInstrumentCurrency?: boolean;
	showRiskInInstrumentCurrency?: boolean;
	supportPartialClosePosition?: boolean;
	supportPartialCloseIndividualPosition?: boolean;
	supportCancellingBothBracketsOnly?: boolean;
	supportCryptoBrackets?: boolean;
	showNotificationsLog?: boolean;
	supportStopOrdersInBothDirections?: boolean;
	supportStopLimitOrdersInBothDirections?: boolean;
	supportStrictCheckingLimitOrderPrice?: boolean;
	supportExecutions?: boolean;
	supportModifyOrderType?: boolean;
	requiresFIFOCloseIndividualPositions?: boolean;
	supportMultipleExitLevels?: boolean;
	supportUnpairedExitLevels?: boolean;
	supportCustomOrderInfo?: boolean;
	supportPreviewClosePosition?: boolean;
}
export interface BrokerCustomUI {
	showOrderDialog?: (order: OrderTemplate | Order, focus?: OrderTicketFocusControl) => Promise<boolean>;
	showPositionDialog?: (position: Position | IndividualPosition, brackets: Brackets, focus?: OrderTicketFocusControl) => Promise<boolean>;
	showCancelOrderDialog?: (order: Order) => Promise<boolean>;
	showClosePositionDialog?: (position: Position | IndividualPosition) => Promise<boolean>;
	showReversePositionDialog?: (position: Position) => Promise<boolean>;
}
export interface ChangeAccountSolution {
	changeAccount: AccountId;
}
export interface ChangeSymbolSolution {
	changeSymbol: string;
}
export interface CheckboxFieldMetaInfo extends CustomFieldMetaInfoBase {
	inputType: "Checkbox";
	value: boolean;
	supportModify?: boolean;
	help?: string;
}
export interface ClosePositionPreviewResult {
	id?: string;
	rows: ClosePositionPreviewRow[];
	disclaimer?: string | MarkupText;
}
export interface ClosePositionPreviewRowData {
	title: string;
	value?: string;
	currency?: string;
}
export interface ClosePositionPreviewSeparator {
	type: "separator";
}
export interface ContractExpirationDate {
	dateOrDateTime: number;
	hasTime: boolean;
}
export interface CryptoBalance {
	symbol: string;
	total: number;
	available: number;
	reserved?: number;
	value?: number;
	valueCurrency?: string;
	longName?: string;
	btcValue?: number;
}
export interface CustomComboBoxItem {
	text: string;
	value: string;
}
export interface CustomComboBoxMetaInfo extends CustomInputFieldMetaInfo {
	inputType: "ComboBox";
	items: CustomComboBoxItem[];
}
export interface CustomFieldMetaInfoBase {
	inputType: string;
	id: string;
	title: string;
	value?: any;
	saveToSettings?: boolean;
}
export interface CustomInputFieldMetaInfo extends CustomFieldMetaInfoBase {
	preventModify?: boolean;
	placeHolder?: string;
	validator?: InputFieldValidator;
	customInfo?: any;
}
export interface CustomInputFieldsValues {
	[fieldId: string]: TextWithCheckboxValue | boolean | string | any;
}
export interface CustomTableElementFormatter<T extends TableFormatterInputValues = TableFormatterInputValues> {
	name: FormatterName;
	formatElement?: CustomTableFormatElementFunction<T>;
	formatText: TableFormatTextFunction<T>;
	isPriceFormatterNeeded?: boolean;
}
export interface DOMData {
	snapshot: boolean;
	asks: DOMLevel[];
	bids: DOMLevel[];
}
export interface DOMLevel {
	price: number;
	volume: number;
}
export interface DefaultContextMenuActionsParams {
}
export interface DefaultDropdownActionsParams {
	tradingProperties?: boolean;
	restoreConfirmations?: boolean;
}
export interface DisconnectionInfo {
	message?: string;
	heading?: string;
	additionalInfo?: string;
	disconnectType?: DisconnectType;
	reason?: DisconnectReason;
}
export interface ErrorFormatterParseResult extends FormatterParseResult {
	error?: string;
	res: false;
}
/** A single fill reported by the broker. */
export interface Execution extends WithExtraData {
	id: string;
	symbol: string;
	price: number;
	qty: number;
	side: Side;
	time: number;
	commission?: number;
	fee?: number;
	netAmount?: number;
	currencyRate?: number;
}
export interface ExitLevel {
	id: string;
	qty: number;
	takeProfit?: number;
	stopLoss?: number;
	guaranteedStop?: number;
	trailingStopPips?: number;
	isExisting?: boolean;
}
export interface ExitLevelTemplate extends ExitLevel {
	tpPips?: number;
	slPips?: number;
	tpRiskInPercent?: number;
	slRiskInPercent?: number;
	tpParentPricePercent?: number;
	slParentPricePercent?: number;
	tpRiskInCurrency?: number;
	slRiskInCurrency?: number;
}
export interface ExtraData {
	[key: string]: any;
}
export interface FormatterFormatOptions {
	ignoreLocaleNumberFormat?: boolean;
}
export interface FormatterParseOptions {
	ignoreLocaleNumberFormat?: boolean;
}
export interface FormatterParseResult {
	res: boolean;
}
export interface HyperlinkInfo {
	text: string;
	url: string;
}
export interface IBoxedValue<T> extends IBoxedValueReadOnly<T> {
	setValue(value: T): void;
}
export interface IBoxedValueReadOnly<T> {
	value(): T;
}
export interface IBrokerAccountInfo {
	accountsMetainfo(): Promise<AccountMetainfo[]>;
	currentAccount(): AccountId;
	setCurrentAccount?(id: AccountId): void;
}
/** Read-only broker surface: account, orders, positions, executions and symbol details. */
export interface IBrokerCommon {
	chartContextMenuActions(context: TradeContext, options?: DefaultContextMenuActionsParams): Promise<ActionMetaInfo[]>;
	isTradable(symbol: string): Promise<boolean | IsTradableResult>;
	connectionStatus(): ConnectionStatus;
	orders(): Promise<Order[]>;
	ordersHistory?(): Promise<Order[]>;
	positions?(): Promise<Position[]>;
	individualPositions?(): Promise<IndividualPosition[]>;
	executions(symbol: string): Promise<Execution[]>;
	symbolInfo(symbol: string): Promise<InstrumentInfo>;
	accountManagerInfo(): AccountManagerInfo;
	formatter?(symbol: string, alignToMinMove: boolean): Promise<INumberFormatter>;
	spreadFormatter?(symbol: string): Promise<INumberFormatter>;
	quantityFormatter?(symbol: string): Promise<INumberFormatter>;
	getOrderDialogOptions?(symbol: string): Promise<OrderDialogOptions | undefined>;
	getPositionDialogOptions?(symbol: string): Promise<PositionDialogOptions | undefined>;
	getSymbolSpecificTradingOptions?(symbol: string): Promise<SymbolSpecificTradingOptions | undefined>;
}
/** Creates the watched values, delegates and formatters a broker integration needs. */
export interface IBrokerConnectionAdapterFactory {
	createDelegate<T extends Function>(): IDelegate<T>;
	createWatchedValue<T>(value?: T): IWatchedValue<T>;
	createPriceFormatter(priceScale?: number, minMove?: number, fractional?: boolean, minMove2?: number, variableMinTick?: string): IPriceFormatter;
}
/** Services the platform gives a broker integration: push updates for orders, positions and executions, connection status, notifications and formatters. */
export interface IBrokerConnectionAdapterHost {
	factory: IBrokerConnectionAdapterFactory;
	connectionStatusUpdate(status: ConnectionStatus, info?: DisconnectionInfo): void;
	defaultFormatter(symbol: string, alignToMinMove: boolean): Promise<INumberFormatter>;
	numericFormatter(decimalPlaces: number): Promise<INumberFormatter>;
	quantityFormatter(decimalPlaces?: number): Promise<INumberFormatter>;
	defaultContextMenuActions(context: TradeContext, params?: DefaultContextMenuActionsParams): Promise<ActionMetaInfo[]>;
	defaultDropdownMenuActions(options?: Partial<DefaultDropdownActionsParams>): ActionMetaInfo[];
	sellBuyButtonsVisibility(): IWatchedValue<boolean> | null;
	domPanelVisibility(): IWatchedValue<boolean> | null;
	orderPanelVisibility(): IWatchedValue<boolean> | null;
	tradedSourcesVisibility(): IWatchedValue<boolean> | null;
	silentOrdersPlacement(): IWatchedValue<boolean>;
	patchConfig(config: Partial<BrokerConfigFlags>): void;
	setDurations(durations: OrderDurationMetaInfo[]): void;
	orderUpdate(order: Order): void;
	ordersFullUpdate(): void;
	orderPartialUpdate(id: string, orderChanges: Partial<Order>): void;
	positionUpdate(position: Position, isHistoryUpdate?: boolean): void;
	positionsFullUpdate(): void;
	positionPartialUpdate(id: string, positionChanges: Partial<Position>): void;
	individualPositionUpdate(individualPosition: IndividualPosition, isHistoryUpdate?: boolean): void;
	individualPositionsFullUpdate(): void;
	individualPositionPartialUpdate(id: string, changes: Partial<IndividualPosition>): void;
	executionUpdate(execution: Execution): void;
	currentAccountUpdate(): void;
	realtimeUpdate(symbol: string, data: TradingQuotes): void;
	plUpdate(positionId: string, pl: number): void;
	pipValueUpdate(symbol: string, pipValues: PipValues): void;
	individualPositionPLUpdate(individualPositionId: string, pl: number): void;
	equityUpdate(equity: number): void;
	marginAvailableUpdate(marginAvailable: number): void;
	cryptoBalanceUpdate(symbol: string, balance: CryptoBalance): void;
	domUpdate(symbol: string, equity: DOMData): void;
	setQty(symbol: string, quantity: number): void;
	getQty(symbol: string): Promise<number>;
	subscribeSuggestedQtyChange(symbol: string, listener: SuggestedQtyChangedListener): void;
	unsubscribeSuggestedQtyChange(symbol: string, listener: SuggestedQtyChangedListener): void;
	showOrderDialog?<T extends PreOrder>(order: T, focus?: OrderTicketFocusControl): Promise<boolean>;
	showNotification(title: string, text: string, notificationType?: NotificationType): void;
	showCancelOrderDialog(orderId: string, handler: () => Promise<void>): Promise<void>;
	showCancelMultipleOrdersDialog(symbol: string, side: Side, qty: number, handler: () => Promise<void>): Promise<void>;
	showCancelBracketsDialog(orderId: string, handler: () => Promise<void>): Promise<void>;
	showCancelMultipleBracketsDialog(orderId: string, handler: () => Promise<void>): Promise<void>;
	showReversePositionDialog(position: string, handler: () => Promise<boolean>): Promise<boolean>;
	showPositionBracketsDialog(position: Position | IndividualPosition, brackets: Brackets, focus: OrderTicketFocusControl): Promise<boolean>;
	activateBottomWidget(): Promise<void>;
	getAccountManagerVisibilityMode(): IWatchedValueReadonly<BottomWidgetBarMode>;
	setAccountManagerVisibilityMode(mode: BottomWidgetBarMode): void;
	showTradingProperties(): void;
	getSymbolMinTick(symbol: string): Promise<number>;
	showMessageDialog(title: string, text: string, textHasHTML?: boolean): void;
	showConfirmDialog(title: string, content: string | string[], mainButtonText?: string, cancelButtonText?: string, showDisableConfirmationsCheckbox?: boolean): Promise<boolean>;
	showSimpleConfirmDialog(title: string, content: string | string[], mainButtonText?: string, cancelButtonText?: string, showDisableConfirmationsCheckbox?: boolean): Promise<boolean>;
	getOrderTicketSetting<K extends keyof OrderTicketSettings>(settingName: K): Promise<OrderTicketSettings[K]>;
	setOrderTicketSetting<K extends keyof OrderTicketSettings>(settingName: K, value: OrderTicketSettings[K]): Promise<void>;
}
/** The interface a broker integration implements. The platform calls it to read account state and to place, modify and cancel orders. */
export interface IBrokerTerminal extends IBrokerCommon, IBrokerAccountInfo {
	placeOrder(order: PreOrder, confirmId?: string): Promise<PlaceOrderResult>;
	previewOrder?(order: PreOrder): Promise<OrderPreviewResult>;
	modifyOrder(order: Order, confirmId?: string): Promise<void>;
	cancelOrder(orderId: string): Promise<void>;
	cancelOrders?(symbol: string, side: Side | undefined, ordersIds: string[]): Promise<void>;
	reversePosition?(positionId: string): Promise<void>;
	closePosition?(positionId: string, amount?: number, confirmId?: string): Promise<void>;
	closeIndividualPosition?(individualPositionId: string, amount?: number, confirmId?: string): Promise<void>;
	editPositionBrackets?(positionId: string, brackets: Brackets, customFields?: CustomInputFieldsValues): Promise<void>;
	editIndividualPositionBrackets?(individualPositionId: string, brackets: Brackets): Promise<void>;
	leverageInfo?(leverageInfoParams: LeverageInfoParams): Promise<LeverageInfo>;
	setLeverage?(leverageSetParams: LeverageSetParams): Promise<LeverageSetResult>;
	previewLeverage?(leverageSetParams: LeverageSetParams): Promise<LeveragePreviewResult>;
	subscribeEquity?(): void;
	subscribeMarginAvailable?(symbol: string): void;
	subscribePipValue?(symbol: string): void;
	unsubscribePipValue?(symbol: string): void;
	unsubscribeMarginAvailable?(symbol: string): void;
	unsubscribeEquity?(): void;
}
/** A list of subscribers that is notified when an event fires. */
export interface IDelegate<TFunc extends Function> extends ISubscription<TFunc> {
	fire: TFunc;
}
export interface IFormatter<T> {
	format(value?: T, options?: FormatterFormatOptions): string;
	parse?(value: string, options?: FormatterParseOptions): ErrorFormatterParseResult | SuccessFormatterParseResult<T>;
}
export interface INumberFormatter extends IFormatter<number> {
	format(value?: number, options?: NumberFormatterFormatOptions): string;
	formatChange?(currentPrice: number, prevPrice: number, options?: NumberFormatterFormatOptions): string;
}
export interface IObservable<T> {
	subscribe(callback: ObservableCallback<T>): void;
	unsubscribe(callback: ObservableCallback<T>): void;
}
export interface IObservableValue<T> extends IBoxedValue<T>, IObservable<T> {
}
export interface IObservableValueReadOnly<T> extends IBoxedValueReadOnly<T>, IObservable<T> {
}
export interface IPriceFormatter extends ISymbolValueFormatter {
	format(price: number, options?: PriceFormatterFormatOptions): string;
	formatChange?(price: number, prevPrice: number, options?: PriceFormatterFormatOptions): string;
}
export interface ISubscription<TFunc extends Function> {
	subscribe(obj: object | null, member: TFunc, singleshot?: boolean): void;
	unsubscribe(obj: object | null, member: TFunc): void;
	unsubscribeAll(obj: object | null): void;
}
export interface ISymbolValueFormatter extends INumberFormatter {
	format(price: number, options?: SymbolValueFormatterFormatOptions): string;
	formatChange?(currentPrice: number, prevPrice: number, options?: SymbolValueFormatterFormatOptions): string;
}
/** A value the platform can read and subscribe to; brokers use it to publish changing state. */
export interface IWatchedValue<T> extends IWatchedValueReadonly<T>, IObservableValue<T> {
	setValue(value: T, forceUpdate?: boolean): void;
	subscribe(callback: WatchedValueCallback<T>, options?: WatchedValueSubscribeOptions): void;
	unsubscribe(callback?: WatchedValueCallback<T> | null): void;
}
export interface IWatchedValueReadonly<T> extends IObservableValueReadOnly<T> {
	subscribe(callback: (value: T) => void, options?: WatchedValueSubscribeOptions): void;
	unsubscribe(callback?: ((value: T) => void) | null): void;
	when(callback: WatchedValueCallback<T>): void;
}
/** One individual position, for brokers that report positions per entry rather than netted. */
export interface IndividualPosition extends IndividualPositionBase, WithExtraData {
}
export interface IndividualPositionBase {
	id: string;
	date: number;
	symbol: string;
	qty: number;
	side: Side;
	price: number;
	message?: OrderOrPositionMessage;
	canBeClosed?: boolean;
	stopLoss?: number;
	takeProfit?: number;
	guaranteedStop?: number;
	trailingStopPips?: number;
	trailingStopPrice?: number;
	stopType?: StopType;
	avgPrice?: number;
	updateTime?: number;
	lastPrice?: number;
	bidPrice?: number;
	askPrice?: number;
	unrealizedPl?: number;
	unrealizedPlPercent?: number;
	unrealizedPlQty?: number;
	marketValue?: number;
	pl?: number;
	visiblePL?: number;
	currency?: string;
	exitLevels?: ExitLevel[];
}
/** Trading parameters for a symbol: quantity limits, tick size, pip value and allowed order types. */
export interface InstrumentInfo {
	qty: QuantityMetainfo;
	pipValue: number;
	pipSize: number;
	minTick: number;
	lotSize?: number;
	type?: SymbolType;
	units?: string;
	brokerSymbol?: string;
	description: string;
	leverage?: string;
	marginRate?: number;
	limitPriceStep?: number;
	stopPriceStep?: number;
	allowedDurations?: string[];
	variableMinTick?: string;
	currency?: string;
	baseCurrency?: string;
	quoteCurrency?: string;
	bigPointValue?: number;
	priceMagnifier?: number;
	allowedOrderTypes?: OrderType[];
}
export interface IsTradableResult {
	tradable: boolean;
	reason?: string;
	reasonHeading?: string;
	solutions?: TradableSolutions;
	shortReason?: string;
	confirmButtonText?: string;
}
export interface LevelsFormatterProperties<T extends string = string> {
	base: [
		priceProperty: FieldRef<T>
	];
	withLevels: [
		priceProperty: FieldRef<T>,
		exitLevels: FieldRef<T>,
		qty: FieldRef<T>
	];
}
export interface LeverageInfo {
	title: string;
	leverage: number;
	min: number;
	max: number;
	step: number;
}
export interface LeverageInfoParams {
	symbol: string;
	orderType: OrderType;
	side: Side;
	customFields?: CustomInputFieldsValues;
}
export interface LeveragePreviewResult {
	infos?: string[];
	warnings?: string[];
	errors?: string[];
}
export interface LeverageSetParams extends LeverageInfoParams {
	leverage: number;
}
export interface LeverageSetResult {
	leverage: number;
}
export interface MenuSeparator extends ActionDescription {
	separator: boolean;
}
export interface NegativeBaseInputFieldValidatorResult extends BaseInputFieldValidatorResult {
	valid: false;
	errorMessage: string;
}
export interface NumberFormatterFormatOptions extends FormatterFormatOptions {
	noExponentialForm?: boolean;
}
export interface OpenUrlSolution {
	openUrl: {
		url: string;
		text: string;
	};
}
export interface OrderDialogOptions extends TradingDialogOptions {
	showTotal?: boolean;
}
export interface OrderDuration {
	type: string;
	datetime?: number;
}
export interface OrderDurationMetaInfo {
	hasDatePicker?: boolean;
	hasTimePicker?: boolean;
	default?: boolean;
	name: string;
	value: string;
	supportedOrderTypes?: OrderType[];
}
export interface OrderOrPositionMessage {
	type: OrderOrPositionMessageType;
	text: string;
}
export interface OrderPreviewResult {
	sections: OrderPreviewSection[];
	confirmId?: string;
	warnings?: OrderPreviewMessage[];
	errors?: OrderPreviewMessage[];
}
export interface OrderPreviewSection {
	rows: OrderPreviewSectionRow[];
	header?: string;
}
export interface OrderPreviewSectionRow {
	title: string;
	value: string;
}
export interface OrderRule {
	id: string;
	severity: "warning" | "error";
}
export interface OrderTemplate extends OrderTemplateBase {
	exitLevels?: ExitLevelTemplate[];
}
export interface OrderTemplateBase {
	symbol: string;
	type?: OrderType;
	side?: Side;
	qty?: number;
	stopType?: StopType;
	currentQuotes?: AskBid;
	stopPrice?: number;
	limitPrice?: number;
	takeProfit?: number;
	stopLoss?: number;
	guaranteedStop?: number;
	trailingStopPips?: number;
	duration?: OrderDuration;
	customFields?: CustomInputFieldsValues;
}
export interface OrderTicketSettings {
	showRelativePriceControl: boolean;
	showOrderPreview: boolean;
}
export interface PipValues {
	buyPipValue: number;
	sellPipValue: number;
}
export interface PlaceOrderResult {
	orderId?: string;
}
/** An order the broker has accepted, with its id and status. */
export interface PlacedOrder extends WithExtraData {
	id: string;
	symbol: string;
	type: OrderType;
	side: Side;
	qty: number;
	status: OrderStatus;
	stopLoss?: number;
	guaranteedStop?: number;
	trailingStopPips?: number;
	trailingStopPrice?: number;
	stopType?: StopType;
	takeProfit?: number;
	exitLevels?: ExitLevel[];
	duration?: OrderDuration;
	customFields?: CustomInputFieldsValues;
	filledQty?: number;
	avgPrice?: number;
	updateTime?: number;
	limitPrice?: number;
	stopPrice?: number;
	message?: OrderOrPositionMessage;
}
/** A net position as reported by the broker. */
export interface Position extends PositionBase, WithExtraData {
}
export interface PositionBase {
	id: string;
	symbol: string;
	qty: number;
	shortQty?: number;
	longQty?: number;
	side: Side;
	avgPrice: number;
	updateTime?: number;
	lastPrice?: number;
	bidPrice?: number;
	askPrice?: number;
	unrealizedPl?: number;
	unrealizedPlPercent?: number;
	unrealizedPlQty?: number;
	marketValue?: number;
	stopLoss?: number;
	takeProfit?: number;
	guaranteedStop?: number;
	trailingStopPips?: number;
	trailingStopPrice?: number;
	stopType?: StopType;
	currency?: string;
	contractExpirationDate?: ContractExpirationDate;
	message?: OrderOrPositionMessage;
	exitLevels?: ExitLevel[];
}
export interface PositionDialogOptions extends TradingDialogOptions {
}
export interface PositiveBaseInputFieldValidatorResult extends BaseInputFieldValidatorResult {
	valid: true;
}
/** An order as submitted from the order ticket, before the broker has accepted it. */
export interface PreOrder extends OrderTemplateBase {
	symbol: string;
	type: OrderType;
	side: Side;
	qty: number;
	isClose?: boolean;
	exitLevels?: ExitLevel[];
}
export interface PriceFormatterFormatOptions extends SymbolValueFormatterFormatOptions {
	tailSize?: number;
	signNegative?: boolean;
	useRtlFormat?: boolean;
	cutFractionalByPrecision?: boolean;
	removeAllEndingZeros?: boolean;
}
export interface QuantityMetainfo {
	min: number;
	max: number;
	step: number;
	uiStep?: number;
	default?: number;
}
/** Broker configuration passed to the trading platform: feature flags, order durations and custom fields. */
export interface SingleBrokerMetaInfo {
	configFlags: BrokerConfigFlags;
	tradedGroupConfig?: TradedGroupConfig;
	customNotificationFields?: string[];
	durations?: OrderDurationMetaInfo[];
	orderRules?: OrderRule[];
	customUI?: BrokerCustomUI;
}
export interface SortingParameters {
	property: FieldRef;
	asc?: boolean;
}
export interface StandardFormattersDependenciesMapping<T extends string = string> {
	[StandardFormatterName.Default]: FieldRef<T>[];
	[StandardFormatterName.Symbol]: SymbolFormatterProperties<T>[keyof SymbolFormatterProperties];
	[StandardFormatterName.Side]: [
		sideProperty: FieldRef<T>
	];
	[StandardFormatterName.PositionSide]: [
		sideProperty: FieldRef<T>
	];
	[StandardFormatterName.Text]: FieldRef<T>[];
	[StandardFormatterName.Type]: [
		orderTypeProperty: FieldRef<T>,
		parentIdProperty: FieldRef<T>,
		stopTypeProperty: FieldRef<T>
	];
	[StandardFormatterName.FormatPrice]: [
		priceProperty: FieldRef<T>
	];
	[StandardFormatterName.FormatPriceForexSup]: [
		priceProperty: FieldRef<T>
	];
	[StandardFormatterName.FormatExitLevels]: LevelsFormatterProperties<T>[keyof LevelsFormatterProperties];
	[StandardFormatterName.FormatPriceInCurrency]: [
		priceProperty: FieldRef<T>,
		currencyProperty: FieldRef<T>
	];
	[StandardFormatterName.Status]: [
		statusProperty: FieldRef<T>
	];
	[StandardFormatterName.Date]: [
		dateProperty: FieldRef<T>
	];
	[StandardFormatterName.LocalDate]: [
		dateProperty: FieldRef<T>
	];
	[StandardFormatterName.DateOrDateTime]: [
		dateProperty: FieldRef<T>
	];
	[StandardFormatterName.LocalDateOrDateTime]: [
		dateProperty: FieldRef<T>
	];
	[StandardFormatterName.Fixed]: [
		valueProperty: FieldRef<T>
	];
	[StandardFormatterName.FixedInCurrency]: [
		valueProperty: FieldRef<T>,
		currencyProperty: FieldRef<T>
	];
	[StandardFormatterName.VariablePrecision]: [
		valueProperty: FieldRef<T>
	];
	[StandardFormatterName.Pips]: [
		pipsProperty: FieldRef<T>
	];
	[StandardFormatterName.IntegerSeparated]: [
		valueProperty: FieldRef<T>
	];
	[StandardFormatterName.FormatQuantity]: [
		qtyProperty: FieldRef<T>
	];
	[StandardFormatterName.Profit]: [
		profitProperty: FieldRef<T>
	];
	[StandardFormatterName.ProfitInInstrumentCurrency]: [
		profitProperty: FieldRef<T>,
		currencyProperty: FieldRef<T>
	];
	[StandardFormatterName.ProfitInInstrumentCurrencyFloored]: [
		profitProperty: FieldRef<T>,
		currencyProperty: FieldRef<T>
	];
	[StandardFormatterName.ProfitInPercent]: [
		plPercent: FieldRef<T>
	];
	[StandardFormatterName.Percentage]: [
		valueProperty: FieldRef<T>
	];
	[StandardFormatterName.ColoredPercentage]: [
		valueProperty: FieldRef<T>
	];
	[StandardFormatterName.MarginPercent]: [
		valueProperty: FieldRef<T>
	];
	[StandardFormatterName.Empty]: [
	];
}
export interface SuccessFormatterParseResult<T> extends FormatterParseResult {
	res: true;
	value: T;
	suggest?: string;
}
export interface SymbolFormatterProperties<T extends string = string> {
	base: [
		symbolDisplayNameProperty: FieldRef<T>,
		symbolProperty: FieldRef<T>
	];
	withMessage: [
		symbolDisplayNameProperty: FieldRef<T>,
		symbolProperty: FieldRef<T>,
		messageProperty: FieldRef<T>
	];
}
export interface SymbolSpecificTradingOptions {
	allowedDurations?: string[];
	allowedOrderTypes?: OrderType[];
	supportOrderBrackets?: boolean;
	supportBracketsInPips?: boolean;
	supportAddBracketsToExistingOrder?: boolean;
	supportModifyBrackets?: boolean;
	supportPositionBrackets?: boolean;
	supportIndividualPositionBrackets?: boolean;
	supportReversePosition?: boolean;
	warningMessage?: string;
	supportModifyPositionBrackets?: boolean;
	supportModifyOrderBrackets?: boolean;
	supportRiskControlsAndInfo?: boolean;
	supportStopLoss?: boolean;
	supportTrailingStop?: boolean;
	supportGuaranteedStop?: boolean;
	supportCryptoExchange?: boolean;
}
export interface SymbolValueFormatterFormatOptions extends NumberFormatterFormatOptions {
	signPositive?: boolean;
}
export interface TableFormatterInputs<T extends TableFormatterInputValues = TableFormatterInputValues> {
	values: T extends [
		...args: infer A
	] ? [
		...A
	] : never;
	prevValues?: Partial<T extends [
		...args: infer A
	] ? [
		...A
	] : never>;
}
export interface TextFieldMetaInfo extends CustomInputFieldMetaInfo {
	inputType: "TextField";
	value: string;
	validator?: TextInputFieldValidator;
	maskWithAsterisk?: boolean;
}
export interface TextWithCheckboxFieldCustomInfo {
	checkboxTitle: string;
	asterix?: boolean;
}
export interface TextWithCheckboxFieldMetaInfo extends CustomInputFieldMetaInfo {
	inputType: "TextWithCheckBox";
	value: TextWithCheckboxValue;
	customInfo: TextWithCheckboxFieldCustomInfo;
	validator?: TextInputFieldValidator;
}
export interface TextWithCheckboxValue {
	text: string;
	checked: boolean;
}
export interface TradableSolutionsTypes {
	changeAccountSolution: ChangeAccountSolution;
	changeSymbolSolution: ChangeSymbolSolution;
	openUrlSolution: OpenUrlSolution;
}
/** The symbol and its current quote, as seen by the order ticket. */
export interface TradeContext {
	symbol: string;
	displaySymbol: string;
	value: number | null;
	formattedValue: string;
	last: number;
}
export interface TradedGroupConfig {
	supportAdaptiveLayout: boolean;
}
export interface TradingDialogOptions {
	customFields?: TradingDialogCustomField[];
	maxExitLevelsCount?: number;
}
export interface TradingQuotes {
	trade?: number;
	size?: number;
	bid?: number;
	bid_size?: number;
	ask?: number;
	ask_size?: number;
	spread?: number;
	isDelayed?: boolean;
	isHalted?: boolean;
	isHardToBorrow?: boolean;
	isNotShortable?: boolean;
	lastSize?: number;
}
export interface WatchedValueSubscribeOptions {
	once?: boolean;
	callWithLast?: boolean;
}
export interface WithExtraData {
	extra?: ExtraData;
}
export type AccountId = Nominal<string, "AccountID">;
export type AccountManagerColumn<TPossibleFields extends string = string> = {
	[TFormatterName in StandardFormatterName | FormatterName]: AccountManagerColumnBase<TFormatterName, TPossibleFields>;
}[StandardFormatterName | FormatterName];
export type ActionMetaInfo = ActionDescriptionWithCallback | MenuSeparator;
export type AskBid = Required<Pick<TradingQuotes, "ask" | "bid">>;
export type CellAlignment = "left" | "right";
export type ClosePositionPreviewRow = ClosePositionPreviewRowData | ClosePositionPreviewSeparator;
export type CustomFieldPossibleTypes = "TextWithCheckBox" | "ComboBox" | "Checkbox" | "TextField";
export type CustomTableFormatElementFunction<T extends TableFormatterInputValues = TableFormatterInputValues> = (inputs: TableFormatterInputs<T>) => undefined | string | HTMLElement;
export type FieldRef<T extends string = string> = T | [
	T,
	...string[]
];
export type FormatterName = Nominal<string, "FormatterName">;
export type IndividualPositionTableColumn = AccountManagerColumn<keyof IndividualPosition>;
export type InputFieldValidator = (value: any) => InputFieldValidatorResult;
export type InputFieldValidatorResult = PositiveBaseInputFieldValidatorResult | NegativeBaseInputFieldValidatorResult;
export type LeverageParams = LeverageInfoParams | LeverageSetParams;
export type MarkupText = (string | HyperlinkInfo)[];
export type Nominal<T, Name extends string> = T & {
	[Symbol.species]: Name;
};
export type ObservableCallback<T> = (value: T) => void;
/** An order as reported by the broker. */
export type Order = PlacedOrder | BracketOrder;
export type OrderPreviewMessage = string | MarkupText;
export type OrderTableColumn = AccountManagerColumn<keyof (PlacedOrder & BracketOrder)> & {
	supportedStatusFilters?: OrderStatusFilter[];
};
export type PositionTableColumn = AccountManagerColumn<keyof Position>;
export type SuggestedQtyChangedListener = (newQty: number) => void;
export type SymbolType = "stock" | "index" | "forex" | "futures" | "bitcoin" | "crypto" | "undefined" | "expression" | "spread" | "cfd" | "economic" | "equity" | "dr" | "bond" | "right" | "warrant" | "fund" | "structured" | "commodity" | "fundamental" | "spot" | "swap" | "option" | "ndf";
export type TableFormatTextFunction<T extends TableFormatterInputValues = TableFormatterInputValues> = (inputs: TableFormatterInputs<T>) => string;
export type TableFormatterInputValue = any;
export type TableFormatterInputValues = TableFormatterInputValue[];
export type TextInputFieldValidator = (value: string) => InputFieldValidatorResult;
export type TradableSolutions = TradableSolutionsTypes[keyof TradableSolutionsTypes];
export type TradingDialogCustomField = CheckboxFieldMetaInfo | TextWithCheckboxFieldMetaInfo | CustomComboBoxMetaInfo | TextFieldMetaInfo;
export type WatchedValueCallback<T> = (value: T) => void;

export {};
