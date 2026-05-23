# Motivation

I've recently been experimenting with automated trading on prediction markets, perpetual futures, and spot, mostly on Polymarket, Hyperliquid, and Binance. Building a bot for any of these is not a simple task. You first need to understand how the market actually works: how prices form, how liquidity sits on the book, how orders get filled or rejected. From that understanding you build a strategy, and only then the engine that powers your trades. This is not the kind of project you want to vibe-code with an LLM. If you skip the learning step, you are more or less guaranteed to lose money in ways you cannot explain afterwards.

Over the past few months I have been reading books and exploring this space from a retail point of view. Order-book microstructure, partial fills, the long list of edge cases that show up around cancels and replaces, how liquidity gets managed across dual trades, and so on.

A lot of people enter this field and start trading without understanding the systems underneath, and that gap is where most of the avoidable losses come from. The goal of this repo is to teach the underlying mechanics from first principles, visually and interactively, so anyone can build a real mental model of how an exchange behaves before they put real money on the line. Think of it as a beginner's guide to how trading works on an exchange, covering the concepts that are shared across most venues.

The project itself was built with an AI-assisted, agentic workflow. I personally reviewed and fixed many issues in the server, and wrote every simulation example from scratch. Nothing in here is just LLM output dumped into a repo; every piece has been read, run, and verified.
