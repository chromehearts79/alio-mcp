// 도구 호출 하나의 실행 맥락. 클라이언트가 요청을 취소하면 그 신호를 네트워크 호출·반복 작업까지 전한다.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

export const runWithSignal = (signal, fn) => store.run({ signal }, fn);
export const currentSignal = () => store.getStore()?.signal;
export const isCancelled = () => currentSignal()?.aborted === true;
