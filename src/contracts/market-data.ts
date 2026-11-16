/**
 * Market-data contracts for the Lumen Charts trading platform: the datafeed a
 * host provides for bars, symbols, quotes and depth.
 *
 * The shapes follow the widely used datafeed API surface so existing
 * datafeeds can be connected without changes.
 */
export const enum SearchInitiationPoint {
	SymbolSearch = "symbolSearch",
	Watchlist = "watchlist",
	Compare = "compare",
	IndicatorInputs = "indicatorInputs"
}
/** One OHLCV bar. `time` is in milliseconds since the Unix epoch, UTC. */
export interface Bar {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}
export interface CurrencyItem {
	id: string;
	code: string;
	logoUrl?: string;
	description?: string;
}
/** A depth-of-market snapshot: bid and ask levels. */
export interface DOMData {
	snapshot: boolean;
	asks: DOMLevel[];
	bids: DOMLevel[];
}
export interface DOMLevel {
	price: number;
	volume: number;
}
/** Capabilities the datafeed reports on start: resolutions, exchanges, symbol types and supported features. */
export interface DatafeedConfiguration {
	exchanges?: Exchange[];
	supported_resolutions?: ResolutionString[];
	units?: Record<string, Unit[]>;
	currency_codes?: (string | CurrencyItem)[];
	supports_marks?: boolean;
	supports_time?: boolean;
	supports_timescale_marks?: boolean;
	symbols_types?: DatafeedSymbolType[];
	symbols_grouping?: Record<string, string>;
}
/** Quote fields for a symbol: last price, bid, ask, change and volume. */
export interface DatafeedQuoteValues {
	ch?: number;
	chp?: number;
	short_name?: string;
	exchange?: string;
	description?: string;
	lp?: number;
	ask?: number;
	bid?: number;
	spread?: number;
	open_price?: number;
	high_price?: number;
	low_price?: number;
	prev_close_price?: number;
	volume?: number;
	original_name?: string;
	rtc?: number;
	rtc_time?: number;
	rch?: number;
	rchp?: number;
	[valueName: string]: string | number | string[] | number[] | undefined;
}
export interface DatafeedSymbolType {
	name: string;
	value: string;
}
export interface Exchange {
	value: string;
	name: string;
	desc: string;
}
export interface HistoryMetadata {
	noData?: boolean;
	nextTime?: number | null;
}
/** Bars, symbol search and symbol resolution for the chart. */
export interface IDatafeedChartApi {
	getMarks?(symbolInfo: LibrarySymbolInfo, from: number, to: number, onDataCallback: GetMarksCallback<Mark>, resolution: ResolutionString): void;
	getTimescaleMarks?(symbolInfo: LibrarySymbolInfo, from: number, to: number, onDataCallback: GetMarksCallback<TimescaleMark>, resolution: ResolutionString): void;
	getServerTime?(callback: ServerTimeCallback): void;
	searchSymbols(userInput: string, exchange: string, symbolType: string, onResult: SearchSymbolsCallback, searchSource?: SearchInitiationPoint): void;
	searchSymbolsPaginated?(options: SymbolSearchPaginatedOptions, onResult: SearchSymbolsPaginatedCallback): void;
	resolveSymbol(symbolName: string, onResolve: ResolveCallback, onError: DatafeedErrorCallback, extension?: SymbolResolveExtension): void;
	getBars(symbolInfo: LibrarySymbolInfo, resolution: ResolutionString, periodParams: PeriodParams, onResult: HistoryCallback, onError: DatafeedErrorCallback): void;
	subscribeBars(symbolInfo: LibrarySymbolInfo, resolution: ResolutionString, onTick: SubscribeBarsCallback, listenerGuid: string, onResetCacheNeededCallback: () => void): void;
	unsubscribeBars(listenerGuid: string): void;
	subscribeDepth?(symbol: string, callback: DOMCallback): string;
	unsubscribeDepth?(subscriberUID: string): void;
	getVolumeProfileResolutionForPeriod?(currentResolution: ResolutionString, from: number, to: number, symbolInfo: LibrarySymbolInfo): ResolutionString;
}
/** Quotes for the trading platform's order ticket, watchlists and depth. */
export interface IDatafeedQuotesApi {
	getQuotes(symbols: string[], onDataCallback: QuotesCallback, onErrorCallback: QuotesErrorCallback): void;
	subscribeQuotes(symbols: string[], fastSymbols: string[], onRealtimeCallback: QuotesCallback, listenerGUID: string): void;
	unsubscribeQuotes(listenerGUID: string): void;
}
/** Datafeed entry point: reports the datafeed configuration once on start. */
export interface IExternalDatafeed {
	onReady(callback: OnReadyCallback): void;
}
export interface LibrarySubsessionInfo {
	description: string;
	id: LibrarySessionId;
	session: string;
	"session-correction"?: string;
	"session-display"?: string;
}
/** Everything the chart needs to know about a resolved symbol: name, session, timezone, price scale and supported resolutions. */
export interface LibrarySymbolInfo {
	name: string;
	base_name?: string[];
	ticker?: string;
	description: string;
	long_description?: string;
	type: string;
	session: string;
	session_display?: string;
	session_holidays?: string;
	corrections?: string;
	exchange: string;
	listed_exchange: string;
	timezone: Timezone;
	format: SeriesFormat;
	pricescale: number;
	minmov: number;
	fractional?: boolean;
	minmove2?: number;
	variable_tick_size?: string;
	has_intraday?: boolean;
	supported_resolutions?: ResolutionString[];
	intraday_multipliers?: string[];
	has_seconds?: boolean;
	has_ticks?: boolean;
	seconds_multipliers?: string[];
	build_seconds_from_ticks?: boolean;
	has_daily?: boolean;
	daily_multipliers?: string[];
	has_weekly_and_monthly?: boolean;
	weekly_multipliers?: string[];
	monthly_multipliers?: string[];
	has_empty_bars?: boolean;
	visible_plots_set?: VisiblePlotsSet;
	volume_precision?: number;
	data_status?: "streaming" | "endofday" | "delayed_streaming";
	delay?: number;
	expired?: boolean;
	expiration_date?: number;
	sector?: string;
	industry?: string;
	currency_code?: string;
	original_currency_code?: string;
	unit_id?: string;
	original_unit_id?: string;
	unit_conversion_types?: string[];
	subsession_id?: string;
	subsessions?: LibrarySubsessionInfo[];
	price_source_id?: string;
	price_sources?: SymbolInfoPriceSource[];
	logo_urls?: [
		string
	] | [
		string,
		string
	];
	exchange_logo?: string;
	library_custom_fields?: Record<string, unknown>;
}
export interface Mark {
	id: string | number;
	time: number;
	color: MarkConstColors | MarkCustomColor;
	text: string;
	customTooltip?: string;
	label: string;
	labelFontColor: string;
	minSize: number;
	borderWidth?: number;
	hoveredBorderWidth?: number;
	imageUrl?: string;
	showLabelWhenImageLoaded?: boolean;
}
export interface MarkCustomColor {
	border: string;
	background: string;
}
/** The time range and bar count requested for a history load. */
export interface PeriodParams {
	from: number;
	to: number;
	countBack: number;
	firstDataRequest: boolean;
}
export interface QuoteDataResponse {
	s: "ok" | "error";
	n: string;
	v: unknown;
}
export interface QuoteErrorData extends QuoteDataResponse {
	s: "error";
	v: object;
}
export interface QuoteOkData extends QuoteDataResponse {
	s: "ok";
	v: DatafeedQuoteValues;
}
/** One row of symbol search results. */
export interface SearchSymbolResultItem {
	symbol: string;
	description: string;
	exchange: string;
	ticker?: string;
	type: string;
	logo_urls?: [
		string
	] | [
		string,
		string
	];
	exchange_logo?: string;
}
export interface SymbolInfoPriceSource {
	id: string;
	name: string;
}
export interface SymbolResolveExtension {
	currencyCode?: string;
	unitId?: string;
	session?: string;
}
export interface SymbolSearchPaginatedOptions {
	exchange: string;
	userInput: string;
	start?: number;
	symbolType: string;
	searchSource?: SearchInitiationPoint;
}
export interface TimescaleMark {
	id: string | number;
	time: number;
	color: MarkConstColors | string;
	labelFontColor?: MarkConstColors | string;
	label: string;
	tooltip: string[];
	customTooltip?: string;
	shape?: TimeScaleMarkShape;
	imageUrl?: string;
	showLabelWhenImageLoaded?: boolean;
}
export interface Unit {
	id: string;
	name: string;
	description: string;
}
export type CustomTimezones = "Africa/Cairo" | "Africa/Casablanca" | "Africa/Johannesburg" | "Africa/Lagos" | "Africa/Nairobi" | "Africa/Tunis" | "America/Anchorage" | "America/Argentina/Buenos_Aires" | "America/Bogota" | "America/Caracas" | "America/Chicago" | "America/El_Salvador" | "America/Halifax" | "America/Juneau" | "America/Lima" | "America/Los_Angeles" | "America/Mexico_City" | "America/New_York" | "America/Phoenix" | "America/Santiago" | "America/Sao_Paulo" | "America/Toronto" | "America/Vancouver" | "Asia/Almaty" | "Asia/Ashkhabad" | "Asia/Bahrain" | "Asia/Bangkok" | "Asia/Chongqing" | "Asia/Colombo" | "Asia/Dhaka" | "Asia/Dubai" | "Asia/Ho_Chi_Minh" | "Asia/Hong_Kong" | "Asia/Jakarta" | "Asia/Jerusalem" | "Asia/Kabul" | "Asia/Karachi" | "Asia/Kathmandu" | "Asia/Kolkata" | "Asia/Kuala_Lumpur" | "Asia/Kuwait" | "Asia/Manila" | "Asia/Muscat" | "Asia/Nicosia" | "Asia/Qatar" | "Asia/Riyadh" | "Asia/Seoul" | "Asia/Shanghai" | "Asia/Singapore" | "Asia/Taipei" | "Asia/Tehran" | "Asia/Tokyo" | "Asia/Yangon" | "Atlantic/Azores" | "Atlantic/Reykjavik" | "Australia/Adelaide" | "Australia/Brisbane" | "Australia/Perth" | "Australia/Sydney" | "Europe/Amsterdam" | "Europe/Athens" | "Europe/Belgrade" | "Europe/Berlin" | "Europe/Bratislava" | "Europe/Brussels" | "Europe/Bucharest" | "Europe/Budapest" | "Europe/Copenhagen" | "Europe/Dublin" | "Europe/Helsinki" | "Europe/Istanbul" | "Europe/Lisbon" | "Europe/Ljubljana" | "Europe/London" | "Europe/Luxembourg" | "Europe/Madrid" | "Europe/Malta" | "Europe/Moscow" | "Europe/Oslo" | "Europe/Paris" | "Europe/Prague" | "Europe/Riga" | "Europe/Rome" | "Europe/Sofia" | "Europe/Stockholm" | "Europe/Tallinn" | "Europe/Vienna" | "Europe/Vilnius" | "Europe/Warsaw" | "Europe/Zagreb" | "Europe/Zurich" | "Pacific/Auckland" | "Pacific/Chatham" | "Pacific/Fakaofo" | "Pacific/Honolulu" | "Pacific/Norfolk" | "US/Mountain";
export type DOMCallback = (data: DOMData) => void;
export type DatafeedErrorCallback = (reason: string) => void;
export type GetMarksCallback<T> = (marks: T[]) => void;
export type HistoryCallback = (bars: Bar[], meta?: HistoryMetadata) => void;
export type LibrarySessionId = "regular" | "extended" | "premarket" | "postmarket" | "24h" | "night";
export type MarkConstColors = "red" | "green" | "blue" | "yellow";
export type Nominal<T, Name extends string> = T & {
	[Symbol.species]: Name;
};
export type OnReadyCallback = (configuration: DatafeedConfiguration) => void;
export type QuoteData = QuoteOkData | QuoteErrorData;
export type QuotesCallback = (data: QuoteData[]) => void;
export type QuotesErrorCallback = (reason: string) => void;
export type ResolutionString = Nominal<string, "ResolutionString">;
export type ResolveCallback = (symbolInfo: LibrarySymbolInfo) => void;
export type SearchSymbolsCallback = (items: SearchSymbolResultItem[]) => void;
export type SearchSymbolsPaginatedCallback = (items: SearchSymbolResultItem[], symbolsRemaining: number, revision?: string) => void;
export type SeriesFormat = "price" | "volume";
export type ServerTimeCallback = (serverTime: number) => void;
export type SubscribeBarsCallback = (bar: Bar) => void;
export type TimeScaleMarkShape = "circle" | "earningUp" | "earningDown" | "earning";
export type Timezone = "Etc/UTC" | CustomTimezones;
export type VisiblePlotsSet = "ohlcv" | "ohlc" | "c" | "hlc";

export {};
