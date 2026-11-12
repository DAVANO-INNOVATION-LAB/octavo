// Compile-time regression only. Never invoke this function or write real data.
import { runImportTransaction } from "../src/lib/import-transaction";
export function checkImportCallbackTypes() {
  const result: string = runImportTransaction(() => "synchronous");
  // @ts-expect-error An async callback cannot be part of a synchronous transaction.
  runImportTransaction(async () => "asynchronous");
  // @ts-expect-error A non-async function returning a Promise is unsafe too.
  runImportTransaction(() => Promise.resolve("asynchronous"));
  return result;
}
