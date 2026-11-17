import runpy
import unittest
from pathlib import Path

compute = runpy.run_path(
    str(Path(__file__).resolve().parents[2] / "src/domains/data/analytics.py")
)["compute"]


class Methods(unittest.TestCase):
    def test_clean(self):
        r = compute(
            "clean",
            ["id", "x"],
            [[" 001 ", "bad"], ["001", "bad"], ["002", None]],
            {"trim": ["id"], "deduplicate": True},
        )
        self.assertEqual(r["summary"]["afterRows"], 2)
        self.assertEqual(r["table"][1]["x"], None)
        outlier = compute(
            "clean", ["v"], [[str(n)] for n in [1, 2, 3, 4, 100]], {"outlier_columns": ["v"]}
        )
        self.assertEqual(outlier["summary"]["outliers"][0]["flaggedRows"], [5])
        self.assertEqual(outlier["summary"]["afterRows"], 5)
        self.assertRaises(ValueError, compute, "clean", ["x"], [["1"]], {"trim": ["unknown"]})

    def test_metric(self):
        rows = [["a", "1", "10", "2"], ["b", "3", "30", "1"]]
        r = compute(
            "metric",
            ["id", "v", "d", "w"],
            rows,
            {"value": "v", "mode": "ratio", "denominator": "d", "unique_key": "id"},
        )
        self.assertEqual(r["table"][0]["value"], "0.1")
        self.assertTrue(r["checks"][0]["passed"])
        r = compute(
            "metric",
            ["v", "w"],
            [["10", "1"], ["20", "3"]],
            {"value": "v", "mode": "weighted_mean", "weight": "w"},
        )
        self.assertEqual(r["table"][0]["value"], "17.5")
        self.assertIsNone(
            compute(
                "metric",
                ["v", "d"],
                [["0", "0"]],
                {"value": "v", "mode": "ratio", "denominator": "d"},
            )["table"][0]["value"]
        )
        self.assertRaises(ValueError, compute, "metric", ["v"], [[None]], {"value": "v"})
        self.assertRaises(
            ValueError,
            compute,
            "metric",
            ["id", "v"],
            [["a", "1"], ["a", "2"]],
            {"value": "v", "unique_key": "id"},
        )

    def test_reconcile(self):
        r = compute(
            "reconcile",
            ["s", "id", "v"],
            [
                ["left", "a", "3"],
                ["left", "a", "2"],
                ["right", "a", "1"],
                ["right", "a", "1"],
                ["right", "a", "1"],
            ],
            {"side": "s", "key": "id", "value": "v"},
        )
        self.assertEqual(r["summary"]["expectedInnerJoinRows"], 6)
        self.assertEqual(r["table"][0]["difference"], "2")
        self.assertTrue(r["table"][0]["manyToMany"])
        self.assertRaises(
            ValueError,
            compute,
            "reconcile",
            ["s", "id", "v"],
            [["left", None, "1"]],
            {"side": "s", "key": "id", "value": "v"},
        )

    def test_retention(self):
        r = compute(
            "retention",
            ["u", "s", "a"],
            [
                ["001", "2026-10-01", "2026-10-01"],
                ["002", "2026-10-01", None],
                ["001", "2026-10-01", "2026-10-02"],
            ],
            {"user": "u", "signup": "s", "activity": "a", "as_of": "2026-10-02", "periods": 3},
        )
        self.assertEqual(r["table"][0]["population"], 2)
        self.assertEqual(r["table"][0]["rate"], 0.5)
        self.assertEqual(r["table"][1]["rate"], 0.5)
        self.assertIsNone(r["table"][2]["rate"])
        self.assertRaises(
            ValueError,
            compute,
            "retention",
            ["u", "s", "a"],
            [["1", "2026-10-02", "2026-10-01"]],
            {"user": "u", "signup": "s", "activity": "a", "as_of": "2026-10-03"},
        )

    def test_funnel(self):
        rows = [
            ["a", "buy", "2026-10-01T00:00:02Z"],
            ["a", "visit", "2026-10-01T00:00:00Z"],
            ["b", "buy", "2026-09-30T23:59:59Z"],
            ["b", "visit", "2026-10-01T00:00:00Z"],
            ["c", "visit", "2026-10-01T00:00:09Z"],
        ]
        p = {
            "user": "u",
            "event": "e",
            "time": "t",
            "steps": ["visit", "buy"],
            "window_seconds": 5,
            "as_of": "2026-10-01T00:00:10Z",
        }
        r = compute("funnel", ["u", "e", "t"], rows, p)
        self.assertEqual([v["users"] for v in r["table"]], [2, 1])
        self.assertEqual(r["summary"]["pendingWindowUsers"], 1)
        self.assertRaises(
            ValueError,
            compute,
            "funnel",
            ["u", "e", "t"],
            [["a", "visit", "2026-10-01T00:00:00"]],
            p,
        )

    def test_attribution(self):
        large = compute(
            "attribution",
            ["d", "p", "v"],
            [
                ["a", "old", "1000000000000000000000000000000"],
                ["a", "new", "1000000000000000000000000000001"],
            ],
            {"dimension": "d", "period": "p", "value": "v", "before": "old", "after": "new"},
        )
        self.assertEqual(large["summary"]["totalChange"], "1")
        r = compute(
            "attribution",
            ["d", "p", "v"],
            [["a", "old", "5"], ["a", "new", "2"], ["b", "new", "4"]],
            {"dimension": "d", "period": "p", "value": "v", "before": "old", "after": "new"},
        )
        self.assertEqual(r["summary"]["totalChange"], "1")
        self.assertTrue(r["checks"][0]["passed"])
        self.assertRaises(
            ValueError,
            compute,
            "attribution",
            ["d", "p", "v"],
            [["a", "old", "1"]],
            {"dimension": "d", "period": "p", "value": "v", "before": "old", "after": "new"},
        )

    def test_ab(self):
        p = {"user": "u", "group": "g", "outcome": "y", "control": "A", "treatment": "B"}
        rows = [[str(i), "A" if i < 10 else "B", "0"] for i in range(20)]
        r = compute("ab", ["u", "g", "y"], rows, p)
        self.assertEqual(r["summary"]["pValue"], 1)
        self.assertIsNone(r["summary"]["relativeLift"])
        self.assertFalse(r["summary"]["significant"])
        rows = [[str(i), "A" if i < 100 else "B", "1" if i >= 100 else "0"] for i in range(200)]
        r = compute("ab", ["u", "g", "y"], rows, p)
        self.assertTrue(r["summary"]["significant"])
        self.assertGreater(r["summary"]["differenceCI"][0], 0)
        self.assertRaises(
            ValueError, compute, "ab", ["u", "g", "y"], [["same", "A", "1"], ["same", "B", "0"]], p
        )
        rows = [[str(i), "A" if i < 90 else "B", "1" if i >= 90 else "0"] for i in range(100)]
        self.assertTrue(compute("ab", ["u", "g", "y"], rows, p)["summary"]["srmFlag"])

    def test_series(self):
        p = {"date": "d", "value": "v", "holdout": 2, "season": 1}
        r = compute("series", ["d", "v"], [[f"2026-10-0{i}", str(i)] for i in range(1, 6)], p)
        self.assertEqual(r["summary"]["mae"], 1.5)
        self.assertEqual(r["summary"]["trendPerDay"], 1)
        self.assertEqual([v["prediction"] for v in r["table"][-2:]], [3, 3])
        zeros = compute("series", ["d", "v"], [[f"2026-10-0{i}", "0"] for i in range(1, 6)], p)
        self.assertIsNone(zeros["summary"]["wape"])
        gap = compute("series", ["d", "v"], [[f"2026-10-0{i}", str(i)] for i in [1, 2, 3, 5, 6]], p)
        self.assertEqual(gap["summary"]["missingDates"], ["2026-10-04"])
        self.assertIsNone(gap["summary"]["evaluation"])
        self.assertRaises(ValueError, compute, "series", ["d", "v"], [["2026-10-01", "1"]] * 5, p)


if __name__ == "__main__":
    unittest.main()
