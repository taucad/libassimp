#!/usr/bin/env python3
"""Strictest available OpenUSD validation for exported assets.

Runs every check the installed usd-core offers and fails on any error,
failed check or warning:
  * usd-core <= 25.x: UsdUtils.ComplianceChecker with ARKit rules (the engine
    behind `usdchecker --arkit`), variants included, asset-level checks on.
  * usd-core >= 26.x: every validator in the UsdValidation registry, run on the
    composed stage; warnings count as failures.
Usage: usd-strict-check.py FILE [FILE ...]
"""
import sys


def compliance(path):
    try:
        from pxr.UsdUtils import complianceChecker  # removed in 26.x
    except ImportError:
        return None
    checker = complianceChecker.ComplianceChecker(
        arkit=True, rootPackageOnly=False, skipVariants=False,
        verbose=False, assetLevelChecks=True)
    checker.CheckCompliance(path)
    # The usd-core 25.x wheels ship without the usdShaders discovery plugin, so
    # Sdr cannot resolve UsdPreviewSurface and every shader reads as invalid.
    # usd-core 26.x runs the same Sdr conformance check through UsdValidation.
    from pxr import Sdr
    sdr_ok = bool(Sdr.Registry().GetShaderNodeByIdentifier("UsdPreviewSurface"))
    failed = [f for f in checker.GetFailedChecks()
              if sdr_ok or "has invalid shader node" not in f]
    return ([f"ComplianceChecker error: {e}" for e in checker.GetErrors()]
            + [f"ComplianceChecker failed: {e}" for e in failed]
            + [f"ComplianceChecker warning: {e}" for e in checker.GetWarnings()])


def validators(path):
    try:
        from pxr import UsdValidation
    except ImportError:
        return None
    from pxr import Usd, UsdUtils
    registry = UsdValidation.ValidationRegistry()
    names = [m.name for m in registry.GetAllValidatorMetadata() if not m.isSuite]
    vals = registry.GetOrLoadValidatorsByName(names)
    # Diagnostics raised while composing (deprecated crate versions, unresolved
    # assets, bad metadata) are failures too.
    delegate = UsdUtils.CoalescingDiagnosticDelegate()
    stage = Usd.Stage.Open(path)
    opened = [f"Stage open diagnostic: {d.commentary}"
              for d in delegate.TakeUncoalescedDiagnostics()]
    if stage is None:
        return opened + [f"UsdValidation: cannot open stage {path}"]
    context = UsdValidation.ValidationContext(vals)
    out = opened
    for err in context.Validate(stage):
        if err.HasNoError():
            continue
        if err.GetType() == UsdValidation.ValidationErrorType.Info:
            continue
        out.append(f"UsdValidation {err.GetType().displayName}: {err.GetErrorAsString()}")
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    from pxr import Usd
    failed = 0
    for path in argv[1:]:
        problems, ran = [], []
        res = compliance(path)
        if res is not None:
            ran.append("compliance --arkit")
            problems += res
        else:
            # usd-core 26.x removed ComplianceChecker; its rules live on as
            # UsdValidation validators.
            res = validators(path)
            if res is not None:
                ran.append("all UsdValidation validators")
                problems += res
        status = "FAIL" if problems else "ok"
        print(f"[{status}] {path} (usd-core {'.'.join(map(str, Usd.GetVersion()))}: {', '.join(ran)})")
        for p in problems:
            print(f"    {p}")
        failed += bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
