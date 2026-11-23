# @vsa/service-kit

The code that every service behind the template runtime shares.
The runtime holds the supplier key and claims the escrow of a hirer.
The service does the job.
`createJobServer` is the HTTP surface of the service.
It has a job route, a pre-check route, a health check and a manifest route.

This page describes the pre-check route, the job context, the open routes and the timing of the job slot.
The head of `src/server.ts` describes the other routes.

## Routes

| Route | Caller | Answer |
|---|---|---|
| `GET /healthz` | anyone | `{ok: true}`, or 503 `{ok: false, reason}` when the last health check failed |
| `GET /agent.json` | anyone | the manifest, as the bytes that the service was given |
| `POST /` | the runtime | the result of the job |
| `POST /precheck` | the runtime | go or refusal, before the runtime claims the escrow |
| anything else | anyone | 404 `{error: "not_found"}` |

A service can add public routes of its own with the option `openRoutes`.
The section "Open routes" describes them.
A server made with no `openRoutes` answers 404 for every other path.

`POST /` and `POST /precheck` need the token of the runtime.
The runtime sends the token in the `authorization` header.
The service reads the token from the setting `SERVICE_AUTH_HEADER`.
A call with no token, or a wrong token, gets 401 `{error: "unauthorized"}`.
The service checks the token before it reads the body.
It does not look at the job slot first.
A stranger cannot learn from an answer that a job runs.

## The pre-check

The runtime claims the escrow of a hirer before it posts the job.
If the service is busy at that time, the job fails after the claim.
The pre-check lets the runtime ask first.
When the service refuses, the runtime does not claim.
The escrow stays open.
The buyer gets the status and the `{error, message}` of the refusal.

### The call

```text
POST /precheck HTTP/1.1
authorization: <the token>
x-vector-escrow-ref: <64 hex characters>#<output index>
x-vector-advert-ref: <64 hex characters>#<output index>
x-vector-advert-model: <the model text of the advert, written as encodeURIComponent writes it>
x-vector-buyer-pkh: <56 hex characters>
x-vector-payment-lovelace: <a whole number>
x-vector-deliver-by-ms: <a whole number>

[{"content": "<request JSON as a string>", "role": "user"}]
```

The body is the body of the job call.
It is the wire message.
The service parses it in the same way as it parses a job.
The six `x-vector-` headers are the job context.
The pre-check needs all six.

### The answers

| Status | Body | When |
|---|---|---|
| 200 | `{"go": true, "reserved_ms": 120000}` | The service can take the job. The slot is now reserved for the escrow of the call. |
| status of the option | `{"error": "<code>", "message": "<words>"}` | The option `precheck` refuses. The status is from 400 to 599. |
| 400 | `{"error": "bad_context", "message": "..."}` | A context header is missing, only some of the six are there, or one has a bad form. |
| 400 | `{"error": "bad_wire" \| "request_too_large", "message": "..."}` | The body is not the wire message, or it is too large. |
| 4xx | the refusal that `refusalOf` reads | The intake of the service refuses the request, for example `bad_shape`. |
| 401 | `{"error": "unauthorized"}` | The token is missing or wrong. The connection closes. |
| 409 | `{"error": "busy", "message": "..."}` | A job runs, or the slot is reserved for another escrow. The option is not asked. |
| 503 | `{"error": "shutting_down", "message": "..."}` | The service stops. It takes no new job. |
| 500 | `{"error": "internal"}` | The option fails, or its answer is not valid. The answer is never a go. |

A status of 2xx is a go for the runtime.
Any other status is a refusal.
A refusal with a status of 500 or more gets a fixed text for the buyer.
The whole message goes to the log.
This is the same rule as for a job.

### The option

```ts
type PrecheckAnswer = { go: true } | { go: false; status: number; error: string; message: string };

createJobServer({
  // ...
  precheck: (request, context) =>
    context.paymentLovelace >= PRICE
      ? { go: true }
      : { go: false, status: 402, error: 'underpaid', message: 'The payment is below the price.' },
});
```

The option is not required.
When there is no option, every pre-check that passes the checks of the kit is a go.

The option gets two arguments.
The first is the request.
The kit parses it with the option `parse`, as for a job.
The second is the job context.

The option answers `{ go: true }`, or a refusal.
A refusal has a status from 400 to 599, a code in `error`, and the words for a person in `message`.
The option can also throw what `refusalOf` reads.
`parse` and `run` do the same.

Any other answer is a fault of the service.
The kit answers 500 `{error: "internal"}` and writes the cause to the log.
It never reads such an answer as a go.
A refusal that `refusalOf` gives with a status below 400 is a fault too.

The option must answer quickly.
The runtime waits 10 seconds for the answer.
It reads no answer as a refusal.

## The job context

The runtime sends six headers on the pre-check call and on the job call.
The job call needs them too: its `x-vector-escrow-ref` names the reservation that the job takes.
The kit reads the headers once, checks the form of each, and gives them to the service code as one object.

| Header | Field of `JobContext` | Form |
|---|---|---|
| `x-vector-escrow-ref` | `escrowRef: string` | The reference of the escrow output: 64 hex characters, `#`, and an output index of at most 10 digits. The kit gives the hex in lower case. |
| `x-vector-advert-ref` | `advertRef: string` | The reference of the advert output. The form is the same. |
| `x-vector-advert-model` | `advertModel: string` | The model text of the advert. The text on the chain is free text, and a header takes visible ASCII only. So the runtime writes the text as `encodeURIComponent` does. The kit decodes it once. The text has 1 to 256 characters and no control character. A plain name stays as it is. |
| `x-vector-buyer-pkh` | `buyerPkh: string` | The key hash of the buyer: 56 hex characters. The kit gives the hex in lower case. |
| `x-vector-payment-lovelace` | `paymentLovelace: bigint` | A whole number of at most 19 digits. It has no sign and no leading zero. |
| `x-vector-deliver-by-ms` | `deliverByMs: number` | A whole number of milliseconds since 1970. A number holds it exactly. It has no sign and no leading zero. |

The rules:

- The service reads the context headers only after the token is right.
- A call with none of the six headers has no context. This is not an error. A runtime that sends no context header works as before.
- A call with some of the six headers, but not all, gets 400 `bad_context`. The six come together.
- A call with a header in a bad form gets 400 `bad_context`. The message names the header and the form. It never shows the value.
- The pre-check needs the context. A pre-check with no context header gets 400 `bad_context`.
- A header that arrives more than once is a bad form.

The service code gets the context in two places.
The option `precheck(request, context)` gets it as the second argument.
The option `run(request, arrivedAt, signal, context)` gets it as the fourth argument.
For a job call with no context headers, `context` is `undefined`.
A service that does not use the context needs no change.

`CONTEXT_HEADERS` has the six header names.
`JobContext` is the type of the object.

## The job slot and the reservation

A service has one job slot.
One job runs at a time.
A second job call gets 409 `{error: "busy"}`.

A go of the pre-check reserves the slot for the escrow of the call.
The rules:

- The job call whose `x-vector-escrow-ref` is that escrow takes the reservation. The job then holds the slot, as any job does.
- A job call of another escrow, or with no context, gets 409 `{error: "busy"}` while the reservation stands. It runs nothing.
- A pre-check of another escrow gets 409 `busy` in the same case. It also gets 409 `busy` while a job runs.
- A pre-check of the same escrow is a go again. The 120 seconds start again.
- A reservation that no job takes ends after 120 seconds. The slot then takes any job.
- A job takes a reservation once. When the job ends, the slot is free for any escrow.
- A job call with no reservation takes the slot as before. It can have a context or not.
- A pre-check whose caller hangs up before the answer is written reserves nothing. A go that nobody heard is no promise.
- A service that stops takes no new job, a reserved job included. The stop waits for the job that runs. It does not wait for a reservation.

The kit looks at the slot twice for a pre-check.
It looks before the option is asked, so that a busy service does no work for the option.
It looks again when the option has answered go, because a job can take the slot while the option runs.
The answer is 409 if the slot is not free then.

## Open routes

A service can serve public paths of its own, next to the four routes above.
The two services of use case 1 (inventory reorder) need it.
One serves a co-sign route.
The other serves a lots file.
The option `openRoutes` of `createJobServer` lists the paths.
A server made with no `openRoutes` answers every request as before.

```ts
interface OpenReply { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
interface OpenRequest {
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body as chunks. The request of the server is one. */
  readonly body: AsyncIterable<Uint8Array | string>;
}
interface OpenRoute {
  readonly path: string;
  readonly methods: readonly ('GET' | 'POST')[];
  readonly handle: (request: OpenRequest) => Promise<OpenReply> | OpenReply;
}

createJobServer({
  // ...
  openRoutes: [{ path: '/lots.json', methods: ['GET'], handle: () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: LOTS_TEXT }) }],
});
```

`OpenReply` has the shape of the answer of the co-sign route of the use-case kit.
`OpenRequest` has the three members of the request of that route.
So the `handle` of that route is an `OpenRoute.handle`, with no wrapper.
The use-case kit imports this kit, and never the other way.

### What an open route is

- It needs no token, and it takes no job slot.
- A job that runs does not block it. A reservation of the slot stays as it was.
- It never runs a job or a pre-check.
- The four paths of the kit win: `/`, `/precheck`, `/healthz` and `/agent.json`.
- The caller can be anyone. The handler checks every rule of its own.

### The check of the list

The kit checks the list when it makes the server.
A bad list gives a `RangeError`, and the server is not made.
The message names the path.
The rules:

- A path starts with `/` and has at most 128 characters.
- A path has only the characters `A-Z a-z 0-9 . _ ~ / -`. It has no `..` and no `//`.
- A query, a `#`, a `%` escape, a space and text that is not ASCII are refused.
- A path is none of the four paths of the kit.
- No path is given twice. A path that needs both methods lists both in one entry.
- `methods` lists `GET`, `POST` or both, each one time. No other value is accepted.
- `handle` is a function.
- The list is an array of plain objects. A getter, a Proxy, an inherited member and a class instance are refused.
- The kit reads each member one time. A later change of the objects changes nothing.
- `openRouteTimeoutMs` is a whole number from 1 to 60,000.

### The match

- `GET` matches the path whatever the query, as `/agent.json` does.
- A route that lists `GET` also answers `HEAD`, with the headers and no body. The handler sees the method `HEAD`.
- `POST` matches only when the whole URL is the path. A query gives 404, as it does for `POST /`.
- A method that the route does not list gives 404 `{error: "not_found"}`.
- A path that is not listed gives the same 404.

### The handler

The kit gives each handler a new plain object with three members: `method`, `headers` and `body`.
It never gives the request of Node.
A request of Node has no member `body`.
The kit reads no byte of the body.
The handler reads it, with a size limit of its own.
The kit calls `handle` with no `this`, so give a function that needs none.

The reply:

- `status` is a whole number from 200 to 599.
- `headers` is a plain object. It has text for each name and each value, and Node can send them.
- `body` is a text.
- The kit writes `content-length` as the number of bytes of the body.
- The kit drops a `content-length` and a `transfer-encoding` of the handler, in any letter case.

The handler is a fault when it throws, rejects, runs longer than the bound, or gives a reply of another shape.
The answer to a fault is 500 `{error: "internal"}`, with `connection: close`.
The answer never holds the cause.
The log gets one line with the path of the route and the message of the cause.
The kit never logs the body or the headers of an open route.

The bound is 60 seconds (`OPEN_ROUTE_TIMEOUT_MS`), which is also the default.
The option `openRouteTimeoutMs` sets a shorter bound.
The kit cannot stop a handler that runs too long.
It ignores the answer that comes late, and it writes the reply one time.

### What a handler does for itself

- It reads the body with its own size limit. The kit sets none.
- It checks who may call and what the call may do.
- It limits how many calls run at once. The kit sets no limit.
- It never throws for a bad request. It answers the status that fits.

### A stop

The wait of a stop is the wait for the job slot.
An open route holds no slot, so a call of an open route never makes a stop report an abandoned job.
A stop refuses no open route.
It closes the connection of a call that is still in flight when the wait is over.

## The timing

| What | Time |
|---|---|
| The runtime waits for the answer of the pre-check | 10 seconds. No answer is a refusal with status 503. This is a rule of the runtime. |
| A go keeps the slot for its escrow | 120 seconds (`RESERVATION_MS`), from the moment the option has answered. |
| A pre-check of the same escrow, again | The 120 seconds start again. |
| The job call of that escrow | It takes the reservation at once. |
| A reservation that no job takes | It ends 120 seconds after the go, to the millisecond. |
| A job that runs | The server writes `102 Processing` every 60 seconds (`HEARTBEAT_MS`). |
| A stop | It waits up to 300 seconds (`SHUTDOWN_WAIT_MS`) for the job that runs. |

All times come from the `clock` option of `createJobServer`.
A test moves the clock by hand.
A clock that is set back ends a reservation at once.
This way a reservation cannot hold the slot for the time that the clock was set back by.

## Settings

The kit reads no new setting.
The runtime needs the setting `SERVICE_PRECHECK_URL` to call the route.
When it is not set, the runtime does not call the pre-check.
The route is then not used, and nothing else changes.
