import { useExchangeStore } from './store';
import { PriceTicker } from './components/PriceTicker';
import { OrderBook } from './components/OrderBook';
import { CandlestickChart } from './components/CandlestickChart';
import { OrderForm } from './components/OrderForm';
import { OpenOrders } from './components/OpenOrders';
import { Balances } from './components/Balances';
import { MatchLog } from './components/MatchLog';
import { TradeTape } from './components/TradeTape';

export function App() {
  const { state, dispatch, refreshOpenOrders } = useExchangeStore();
  return (
    <div className="app">
      <PriceTicker state={state} />
      <CandlestickChart
        state={state}
        onIntervalChange={(i) => dispatch({ type: 'set_interval', interval: i })}
      />
      <OrderForm
        state={state}
        onUserChange={(apiKey, userId) => dispatch({ type: 'set_user', apiKey, userId })}
      />
      <OpenOrders state={state} onAfterCancel={refreshOpenOrders} />
      <OrderBook state={state} />
      <Balances state={state} />
      <MatchLog state={state} />
      <TradeTape state={state} />
    </div>
  );
}
