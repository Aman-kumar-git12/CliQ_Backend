// Remembers which validation schemas belong to which middleware, so the OpenAPI document can be
// generated from the routes themselves instead of being maintained by hand.
const schemasByMiddleware = new WeakMap();

const tag = (middleware, schemas) => schemasByMiddleware.set(middleware, schemas);
const schemasOf = (middleware) => schemasByMiddleware.get(middleware);

module.exports = { tag, schemasOf };
