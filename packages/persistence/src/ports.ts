/** Storage-neutral read port. Concrete adapters are introduced with the database stage. */
export interface ReadRepository<TEntity, TId> {
  findById(id: TId): Promise<TEntity | null>;
}

/** Transaction boundary; transaction details remain adapter-owned. */
export interface TransactionRunner<TTransaction> {
  run<TResult>(work: (transaction: TTransaction) => Promise<TResult>): Promise<TResult>;
}
