# @vsa/service-kit

The code that every service behind the template runtime shares.
The runtime holds the supplier key and claims the escrow of a hirer.
The service does the job.
`createJobServer` is the HTTP surface of the service.
It has a job route, a pre-check route, a health check and a manifest route.

This page describes the pre-check route, the job context and the timing of the job slot.
The head of `src/server.ts` describes the other routes.

## Routes

| Route | Caller | Answer |
|---|---|---|
| `GET /healthz` | anyone | `{ok: true}`, or 503 `{ok: false, reason}` when the last health check failed |
| `GET /agent.json` | anyone | the manifest, as the bytes that the service was given |
| `POST /` | the runtime | the result of the job |
| `POST /precheck` | the runtime | go or refusal, before the runtime claims the escrow |
| anything else | anyone | 404 `{error: "not_found"}` |

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
