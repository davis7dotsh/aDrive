import { Context } from 'effect';

export class Db extends Context.Service<Db, D1Database>()('app/Db') {}

export class Bucket extends Context.Service<Bucket, R2Bucket>()('app/Bucket') {}
