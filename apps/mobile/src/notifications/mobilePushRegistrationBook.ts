import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import { createPushRegistrationBook, type PushRegistrationBook } from "./pushRegistrationBook";

let book: PushRegistrationBook | undefined;

/** One for the app, so every caller shares its one queue of writes. */
export function mobilePushRegistrationBook(): PushRegistrationBook {
  book ??= createPushRegistrationBook(createExpoSecureStringStorage());
  return book;
}
