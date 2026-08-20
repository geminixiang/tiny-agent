#!/usr/bin/env node
import { main } from "./index.js";

main().catch(error => { console.error(error.message); process.exitCode = 1; });
