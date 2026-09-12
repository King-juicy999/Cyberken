# Cyberken — Cross-Chain Collateral Unlock

*A DeFi module built on the Attestcoin Protocol for BUIDL CTC 2026 Fall*

**Track:** DeFi
**Sponsor tech:** Creditcoin · Attestcoin Protocol (read-side attestations)
**Stage:** Contracts written and compiling, live testnet run pending funding

## One Sentence

Cyberken lets a lending contract on Creditcoin trustlessly verify a collateral fact from
Ethereum and automatically unlock or adjust a borrower's credit line, with no bridge and
no centralized oracle.

## The Problem

- Lending protocols today can only act on data that's already on their own chain. If a
  borrower's real collateral, credential, or history lives on another chain, the protocol
  has no trustless way to see it.
- Bridges solve this by asking you to trust a third-party operator to relay the fact,
  reintroducing exactly the centralization DeFi is meant to remove.
- Result: cross-chain lending either doesn't happen, or happens through a middleman.

## The Insight

The Attestcoin Protocol lets a smart contract on Creditcoin read a verified fact from
Ethereum directly, no bridge, no oracle operator, cryptographic verification instead of
institutional trust. That is the exact primitive undercollateralized cross-chain lending
needs.

## What We're Building

1. A borrower records a collateral fact on Sepolia through `CollateralAttestor.sol`,
   which emits a `CollateralFactRecorded` event.
2. `CreditLineManager.sol` on Creditcoin proves that event using the Attestcoin Protocol,
   trusting only the registered source contract address.
3. If the fact clears a policy threshold, the contract unlocks or adjusts the borrower's
   credit line automatically, on-chain, no human in the loop.
4. A `CreditLineUnlocked` event is emitted recording the borrower, new limit, and source
   transaction hash, so the whole flow is auditable.

```
Sepolia (CollateralAttestor.sol)
  -> CollateralFactRecorded event emitted
  -> Attestcoin Protocol proves the event
  -> CreditLineManager.sol on Creditcoin reads verified fact
  -> Policy check against threshold
  -> Credit line unlocked/adjusted on Creditcoin
  -> CreditLineUnlocked event emitted (auditable, no oracle, no bridge)
```

## What's Live vs. What BUIDL CTC Builds

- **Live:** Foundry + TypeScript project scaffolded. `CollateralAttestor.sol` (Sepolia)
  and `CreditLineManager.sol` (Creditcoin ASC) written and compiling cleanly (`forge build`
  passing, solc 0.8.30, via_ir). Proof-submission script (`submit_collateral_proof.ts`)
  and source-registration script (`register_source_attestor.ts`) written and type-checked.
- **BUIDL CTC deliverable:** the live end-to-end run, deploying both contracts to their
  respective testnets, registering the trusted source contract, and executing the full
  record-prove-unlock flow with real transaction hashes and a recorded demo.

## Why This Wins

- Attestcoin isn't name-checked, it's the mechanism the entire unlock decision depends on.
- Directly aligned with Creditcoin's own thesis: real-world credit and lending infrastructure.
- Honestly scoped: one clear cross-chain primitive, fully working, rather than a broad but
  shallow feature set.

## Links

- Repo: https://github.com/King-juicy999/Cyberken
- Docs referenced: https://docs.attestcoin.org/

---

*Website crafted by William.*
