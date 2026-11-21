/** Nominal marker for primitive identifiers. */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
