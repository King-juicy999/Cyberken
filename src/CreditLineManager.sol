// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";

/**
 * @title CreditLineManager
 * @notice An Attestcoin Smart Contract (ASC) on Creditcoin that acts on a *verified* fact
 *         from Ethereum/Sepolia: it proves a {CollateralFactRecorded} event, checks the fact
 *         value against a policy threshold, and unlocks or increases the borrower's credit
 *         line. No bridge. No centralized oracle.
 *
 * @dev Security model (mirrors the reference ASCLoanManager):
 *      1. Proof of inclusion + chain continuity is verified by the Creditcoin native block
 *         prover precompile inside `ASCBase.execute`.
 *      2. Queries are deduplicated by `queryId`, so a given source transaction is applied
 *         exactly once.
 *      3. Only {CollateralFactRecorded} events emitted by the ONE registered
 *         `sourceCollateralAttestor` contract are accepted (see {_decodeFactLog}). An
 *         arbitrary contract emitting an inflated fact cannot unlock anything.
 *
 *      Loan policy: a fact must be >= `collateralThreshold` to move the line, and a proof
 *      only ever increases it (monotonic) — events are fully auditable via {CreditLineUnlocked}.
 */
contract CreditLineManager is Ownable, ASCBase {
    /// @notice Action discriminator passed to `ASCBase.execute`.
    enum ManagerActions {
        UnlockCreditLine // 0
    }

    error InvalidAction(uint8 action);

    /// @notice CollateralFactRecorded event signature: keccak256("CollateralFactRecorded(address,uint256,uint256)")
    bytes32 public constant FACT_EVENT_SIGNATURE =
        0x6c5b2e62408ebfb3c1beecd425f62f7ff9ef68164515d636391eb52f058c5f52;

    /// @notice The one Sepolia contract allowed to emit the facts we act upon.
    address public sourceCollateralAttestor;

    /// @notice Policy: a proved fact must be >= this value to unlock/increase credit.
    uint256 public collateralThreshold;

    /// @notice Active credit line per borrower (0 = locked / no line).
    mapping(address => uint256) public creditLines;

    /// @notice Source attestor registered (trust anchor for incoming facts).
    event SourceCollateralAttestorRegistered(address indexed attestor);
    /// @notice Policy threshold updated.
    event CollateralThresholdSet(uint256 threshold);
    /// @notice A proved fact cleared the policy and moved a borrower's credit line.
    /// @param borrower Whose line moved.
    /// @param newCreditLine The new (unlocked/increased) credit line.
    /// @param sourceTxId queryId = keccak(chainKey, blockHeight, txIndex) of the proved
    ///                   Sepolia transaction — uniquely cites the source tx on-chain.
    event CreditLineUnlocked(address indexed borrower, uint256 newCreditLine, bytes32 indexed sourceTxId);

    /**
     * @param _initialCollateralThreshold Minimum fact value required to unlock credit.
     */
    constructor(uint256 _initialCollateralThreshold) Ownable(msg.sender) {
        collateralThreshold = _initialCollateralThreshold;
    }

    /**
     * @notice Trust a specific Sepolia {CollateralAttestor} contract as the fact emitter.
     * @dev Owner-only, one-time (or re-pointable). Any fact log whose emitting address does
     *      not match is rejected.
     * @param _attestor Address of the source-chain CollateralAttestor contract.
     */
    function registerSourceCollateralAttestor(address _attestor) external onlyOwner {
        require(_attestor != address(0), "Attestor cannot be the zero address");
        sourceCollateralAttestor = _attestor;
        emit SourceCollateralAttestorRegistered(_attestor);
    }

    /**
     * @notice Update the policy threshold (minimum fact value to unlock credit).
     * @dev Owner-only.
     * @param _collateralThreshold New threshold.
     */
    function setCollateralThreshold(uint256 _collateralThreshold) external onlyOwner {
        collateralThreshold = _collateralThreshold;
        emit CollateralThresholdSet(_collateralThreshold);
    }

    /// @dev ASCBase hook: proof already verified + query deduplicated — run app logic.
    function _processAndEmitEvent(
        uint8 action,
        bytes32 queryId,
        bytes memory encodedTransaction
    ) internal override {
        if (action != uint8(ManagerActions.UnlockCreditLine)) {
            revert InvalidAction(action);
        }
        _processCollateralFact(queryId, encodedTransaction);
    }

    /// @dev Decode the proved transaction, apply the policy, and move the borrower's line.
    function _processCollateralFact(bytes32 queryId, bytes memory encodedTransaction) internal {
        // We expect exactly the CollateralFactRecorded event in a successful tx.
        EvmV1Decoder.LogEntry[] memory factLogs = _validateTransactionContents(encodedTransaction);
        (address borrower, uint256 factValue) = _decodeFactLog(factLogs[0]);

        // Policy: the proved fact must clear the collateral threshold before credit moves.
        require(factValue >= collateralThreshold, "Collateral fact below policy threshold");

        // Unlock (0 -> V) or increase (V -> W > V). A proof never shrinks a credit line.
        require(factValue > creditLines[borrower], "Collateral fact does not increase credit line");

        creditLines[borrower] = factValue;

        emit CreditLineUnlocked(borrower, factValue, queryId);
    }

    /// @dev Validate tx type, receipt status, and that it contains our event.
    function _validateTransactionContents(
        bytes memory encodedTransaction
    ) internal pure returns (EvmV1Decoder.LogEntry[] memory factLogs) {
        // Validate transaction type
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported transaction type");

        // Decode and validate receipt status
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "Transaction did not succeed");

        // Find the CollateralFactRecorded events and validate
        factLogs = EvmV1Decoder.getLogsByEventSignature(receipt, FACT_EVENT_SIGNATURE);
        require(factLogs.length > 0, "No CollateralFactRecorded events found");
    }

    /// @dev Decode the first fact log and verify it was emitted by the registered attestor.
    function _decodeFactLog(
        EvmV1Decoder.LogEntry memory log
    ) internal view returns (address borrower, uint256 factValue) {
        require(log.topics.length == 2, "Invalid CollateralFactRecorded topics");
        require(log.topics[0] == FACT_EVENT_SIGNATURE, "Not a CollateralFactRecorded event");

        // Verify the event was emitted by the registered source-chain attestor. Without
        // this, anyone could deploy a contract that records an inflated fact, prove it,
        // and unlock credit they were never entitled to.
        require(sourceCollateralAttestor != address(0), "Source attestor not registered!");
        require(
            log.address_ == sourceCollateralAttestor,
            "CollateralFactRecorded event not emitted by registered source attestor!"
        );

        // borrower is the single indexed topic; data carries (factValue, timestamp).
        borrower = address(uint160(uint256(log.topics[1])));

        require(log.data.length == 64, "Invalid CollateralFactRecorded data");
        (factValue, ) = abi.decode(log.data, (uint256, uint256));

        return (borrower, factValue);
    }
}