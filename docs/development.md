# Development and validation

Run the repository test suite from the root:

```sh
npm test
```

This builds the TypeScript project and runs the observer, firmware, dashboard, and tooling tests.

For Mona preparation, rendering, firmware export, and browser-pixel verification:

```sh
npm run prepare:mona --prefix tools
npm run render:mona --prefix tools
npm run export:firmware --prefix tools
npm test --prefix tools
npm run verify:mona --prefix tools
```

These tools do not upload assets to a device. Browser pixel checks verify decoded output; they are not a visual review or hardware validation. See [`tools/MONA.md`](../tools/MONA.md) for asset sources, rendering, and adapter details, and [firmware build and recovery](../firmware/README.md) for device build and upload procedures.
