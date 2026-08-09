# Kleisli composition for machine commands — why the DSL sequences the way it does

> Source: design note supplied by the user (2026-08-09), stored verbatim in content.
> Only change: mangled `[ ... ]` math delimiters and stray `====` artifacts from the
> paste round-trip were normalized to `$$ ... $$`. No wording was altered.
> Companion to [DESIGN-01-semantic-cam-architecture.md](./DESIGN-01-semantic-cam-architecture.md),
> which references Kleisli composition in sections 6 and 35.

A **Kleisli category** is what you get when ordinary function composition is no longer enough because computations have an *effect*—failure, state, nondeterminism, logging, async work, etc.

For the CAM system, it is useful because a machining command is not really:

$$\text{MachineState} \to \text{MachineState}$$

It can also fail, produce measurements, emit a trace, update stock, and so on.

## 1. Start with ordinary functions

Suppose we have:

$$f:A\to B$$

and

$$g:B\to C.$$

We compose them normally:

$$g\circ f:A\to C.$$

In JavaScript:

```js
const f = a => makeB(a);
const g = b => makeC(b);

const h = a => g(f(a));
```

The important thing is that the output type of `f` exactly matches the input type of `g`.

---

## 2. Effects break ordinary composition

Suppose `f` can fail.

Instead of:

$$f:A\to B$$

we now have:

$$f:A\to \mathit{Result}\langle B\rangle.$$

For example:

```js
function selectTool(id) {
  if (!toolExists(id))
    return { ok: false, error: "unknown tool" };

  return {
    ok: true,
    value: getTool(id)
  };
}
```

And suppose:

```js
function checkRPM(tool) {
  return {
    ok: true,
    value: recommendedRPM(tool)
  };
}
```

has type roughly:

$$\mathit{Tool}\to \mathit{Result}\langle \mathit{RPM}\rangle.$$

You can't just write mathematical composition:

$$\mathit{checkRPM}\circ \mathit{selectTool}$$

because `selectTool` produces:

$$\mathit{Result}\langle \mathit{Tool}\rangle$$

while `checkRPM` expects:

$$\mathit{Tool}.$$

There is an extra wrapper.

---

# 3. Kleisli composition solves exactly this

A monad $M$ gives us computations shaped like:

$$A\to M(B).$$

A **Kleisli arrow**

$$A \rightsquigarrow B$$

is simply an ordinary function:

$$A\to M(B).$$

The funny arrow is useful notation:

$$A \rightsquigarrow B \quad := \quad A\to M(B).$$

So for `Result`:

$$\mathit{ToolId}\rightsquigarrow \mathit{Tool}$$

actually means:

$$\mathit{ToolId}\to \mathit{Result}\langle \mathit{Tool}\rangle.$$

And:

$$\mathit{Tool}\rightsquigarrow \mathit{RPM}$$

means:

$$\mathit{Tool}\to \mathit{Result}\langle \mathit{RPM}\rangle.$$

The Kleisli category tells us how to compose these anyway.

---

# 4. `bind` is the crucial operation

Suppose:

$$f:A\to M(B)$$

and:

$$g:B\to M(C).$$

The monad supplies an operation usually called `bind`:

$$M(B)\times(B\to M(C)) \to M(C).$$

For `Result`, `bind` means approximately:

```js
function bind(result, next) {
  if (!result.ok)
    return result;

  return next(result.value);
}
```

So Kleisli composition is:

```js
const composeK = (f, g) =>
  a => bind(f(a), g);
```

Mathematically:

$$g \star f = a\mapsto f(a) \mathbin{>\!\!>\!\!=} g.$$

Now:

$$A\rightsquigarrow B$$

and:

$$B\rightsquigarrow C$$

compose into:

$$A\rightsquigarrow C.$$

That's the central idea.

---

# 5. Why call it a *category*?

Because these effectful computations still satisfy the category laws.

We have objects:

$$A,B,C,\ldots$$

and morphisms:

$$A\to M(B).$$

There is an identity Kleisli arrow:

$$\eta_A:A\to M(A)$$

where $\eta$, often called `pure` or `return`, simply puts a value into the effect:

```js
const pure = x => ({
  ok: true,
  value: x
});
```

And composition is Kleisli composition.

The monad laws guarantee:

### Left identity

$$f\star \eta=f$$

### Right identity

$$\eta\star f=f$$

### Associativity

$$h\star(g\star f) = (h\star g)\star f.$$

So effectful programs can be composed with the same algebraic predictability as ordinary functions.

---

# 6. A CNC example: commands that can fail

Imagine:

```ts
type MachineState = {
  tool: Tool | null;
  spindle: "off" | "cw";
  rpm: number;
  position: Point3;
};
```

A command could have the type:

```ts
type Command<A> =
  (state: MachineState) =>
    Result<[A, MachineState]>;
```

For example:

```js
const startSpindle = rpm => state => {
  if (!state.tool) {
    return {
      ok: false,
      error: "Cannot start spindle without a tool"
    };
  }

  if (rpm > 24000) {
    return {
      ok: false,
      error: "RPM exceeds machine limit"
    };
  }

  return {
    ok: true,
    value: [
      undefined,
      {
        ...state,
        spindle: "cw",
        rpm
      }
    ]
  };
};
```

And:

```js
const cutTo = point => state => {
  if (state.spindle !== "cw") {
    return {
      ok: false,
      error: "Cannot cut with spindle stopped"
    };
  }

  return {
    ok: true,
    value: [
      undefined,
      {
        ...state,
        position: point
      }
    ]
  };
};
```

These aren't ordinary state-transforming functions.

They are:

$$\mathit{State} \to \mathit{Result}(A\times \mathit{State}).$$

This combines two effects:

1. **State**
2. **Failure**

---

# 7. Why Kleisli composition is convenient here

We want to write:

```js
toolChange(T1)
startSpindle(10000)
cutTo(p1)
cutTo(p2)
stopSpindle()
```

But each operation potentially changes state or fails.

Kleisli composition lets us define sequencing once:

```js
const seq = (a, b) => state => {
  const r1 = a(state);

  if (!r1.ok)
    return r1;

  const [, state2] = r1.value;

  return b(state2);
};
```

Then:

```js
const program =
  seq(
    toolChange(T1),
    seq(
      startSpindle(10000),
      seq(
        cutTo(p1),
        cutTo(p2)
      )
    )
  );
```

Conceptually:

$$\mathit{ToolChange} \star \mathit{StartSpindle} \star \mathit{CutTo}(p_1) \star \mathit{CutTo}(p_2).$$

You don't manually write:

```text
if toolChange succeeded...
    take its state...
    if startSpindle succeeded...
        take its state...
        if cut succeeded...
```

The composition operator handles that plumbing.

---

# 8. The State monad by itself

Ignore failure for a moment.

A stateful computation returning a value $A$ has the shape:

$$\mathit{State}\to(A\times \mathit{State}).$$

Call that:

$$\mathit{StateM}(A).$$

So:

$$\mathit{StateM}(A) = \mathit{State}\to(A\times \mathit{State}).$$

Then a Kleisli arrow:

$$X\rightsquigarrow Y$$

is:

$$X\to \mathit{StateM}(Y).$$

Expanding it:

$$X \to \big( \mathit{State}\to(Y\times \mathit{State}) \big).$$

That's why monads can initially look unnecessarily abstract: the notation hides a fairly ugly function type.

---

# 9. `getPosition` shows why there is a return value

A machine operation doesn't always just return `void`.

For example:

```js
const getPosition = state => [
  state.position,
  state
];
```

Its semantic type is:

$$\mathit{State}\to(\mathit{Point}\times \mathit{State}).$$

A probe might be even more interesting:

```js
const probeZ = target => state => {
  // machine runs probe...

  return [
    measuredContactPosition,
    newState
  ];
};
```

Now the measured position can feed the next computation:

```js
probeZ(...)
  >>= measuredZ =>
setWorkOffset(measuredZ)
```

This is one place where Kleisli composition becomes much more than fancy sequencing.

**The output of one effectful operation determines the next effectful operation.**

---

# 10. This is what `flatMap` is

If you've used:

```js
Promise.then(...)
```

or:

```js
array.flatMap(...)
```

or Rust:

```rust
Result::and_then
```

or Haskell:

```haskell
>>=
```

you've encountered essentially this idea.

For a `Promise`:

```js
fetchModel()
  .then(parseModel)
  .then(generateToolpath)
  .then(verifyToolpath);
```

Each function may return another promise.

`then` knows how to avoid producing:

```text
Promise<
  Promise<
    Promise<...>
  >
>
```

That flatten-and-sequence operation is monadic bind.

Therefore:

```js
Promise<A>
```

also gives rise to a Kleisli category where arrows look like:

$$A\to \mathit{Promise}\langle B\rangle.$$

---

# 11. Why a monad is needed

You might wonder:

> Why don't we just define some custom composition function?

You can.

A monad is basically the statement that this custom notion of sequencing has a sufficiently regular algebra.

At minimum, think of a monad as supplying:

```ts
pure:
  A -> M<A>

flatMap:
  M<A> ->
  (A -> M<B>) ->
  M<B>
```

From those, we derive Kleisli composition:

```ts
composeK:
  (A -> M<B>) ->
  (B -> M<C>) ->
  (A -> M<C>)
```

So:

```text
Monad
   ↓
defines legal sequencing
   ↓
Kleisli category
```

---

# 12. Another CNC effect: logging

Suppose every operation should produce a physical trace.

Instead of:

$$\mathit{State}\to \mathit{Result}(A\times \mathit{State})$$

we might have:

$$\mathit{State} \to \mathit{Result}(A\times \mathit{State}\times \mathit{Trace}).$$

A move could produce:

```js
{
  state: newState,

  trace: [
    {
      kind: "tool-motion",
      from,
      to,
      mode: "cut"
    }
  ]
}
```

Sequential composition combines traces:

$$\mathit{Trace}_1 \mathbin{+\!\!+} \mathit{Trace}_2.$$

This is analogous to the **Writer monad**.

Now the interpreter can simultaneously compute:

```text
final machine state
+
failure/success
+
physical motion trace
```

without individual commands having to know how an entire program is assembled.

---

# 13. Stock removal fits naturally too

For CAM, our state can be richer:

$$\Sigma = (\mathit{pose}, \mathit{tool}, \mathit{spindle}, \mathit{fixture}, \mathit{stock}).$$

Then a `cut` morphism changes:

$$\mathit{stock}$$

according to:

$$S' = S\setminus \operatorname{Sweep}(T,\gamma).$$

So operationally:

```text
Cut(path)
```

acts like:

$$\Sigma\to \mathit{Result}(\Sigma\times \mathit{Trace}).$$

And semantically it might:

1. verify a tool exists;
2. verify spindle state;
3. verify feed;
4. verify axis limits;
5. calculate the tool sweep;
6. remove that sweep from stock;
7. update machine position;
8. emit a trace.

That whole operation can still be composed with another command using exactly the same Kleisli operator.

---

# 14. Compare ordinary versus Kleisli composition

Ordinary category:

```text
A --f--> B --g--> C
```

Functions:

$$f:A\to B$$

$$g:B\to C$$

Composition:

$$A\xrightarrow{g\circ f}C.$$

Kleisli category for $M$:

```text
A --f--> M<B>
            |
            | bind g
            v
           M<C>
```

where:

$$f:A\to M(B)$$

$$g:B\to M(C).$$

But in the **Kleisli category**, we draw these simply as:

```text
A --f--> B --g--> C
```

because the $M$ is understood.

That's the trick.

We invent a new category in which **effectful computations look like ordinary arrows again**.

---

# 15. Why this is relevant to our CAM API

This gives a precise mathematical meaning to code such as:

```js
program
  .toolChange(T1)
  .spindleCW(rpm(10000))
  .traverseTo(p0)
  .cut(path1)
  .cut(path2)
  .stopSpindle();
```

Surface syntax makes it look like method chaining.

But semantically it can mean composition of arrows:

$$\Sigma \rightsquigarrow \Sigma \rightsquigarrow \Sigma \rightsquigarrow \cdots$$

where the hidden effect contains:

```text
machine state
failure
trace
possibly warnings
possibly measurements
```

So the program gets a very useful law:

$$(P;Q);R=P;(Q;R).$$

That means we can safely regroup programs:

```js
const rough = seq(...roughingOps);
const finish = seq(...finishOps);

const job =
  seq(setup, rough, finish, shutdown);
```

without changing their semantics.

That associativity is what makes large programs hierarchically composable.

---

# 16. One subtle but important point

The **Kleisli category is not the monad**.

The monad $M$ gives you machinery like:

$$\eta$$

and:

$$\mathbin{>\!\!>\!\!=}$$

From that monad, you construct a category:

$$Kl(M)$$

called its **Kleisli category**.

Its:

* objects are the same underlying types $A,B,C,\ldots$;
* arrows $A\to B$ are functions $A\to M(B)$;
* identities use `pure`;
* composition uses `bind`.

So:

$$\mathit{Monad} \quad\Longrightarrow\quad \mathit{Kleisli\ Category}.$$

---

# 17. The shortest possible intuition

If ordinary function composition says:

> **Take the result of computation A and give it to B.**

Kleisli composition says:

> **Run computation A, correctly handle its computational context/effects, then give its successful value to B.**

For the CNC library, that's roughly:

> **Execute one semantic machine operation, propagate its machine state, measurements, trace and possible failure, then execute the next.**

That is why I brought up Kleisli composition in the CAM architecture: it gives us a mathematically clean model for sequencing **stateful, fallible, physically meaningful machine actions** while preserving ordinary-looking composition laws.
