import { Line } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip } from "chart.js";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip);

export default function ChartView({ title, data }) {
  const labels = Array.isArray(data?.labels) ? data.labels : [];
  const rawValues = Array.isArray(data?.values) ? data.values : [];
  const values = rawValues.map(Number);
  if (!labels.length || labels.length !== values.length || rawValues.some((value) => value === null || value === undefined || value === "") || values.some((value) => !Number.isFinite(value))) return null;

  return (
    <section className="panel chart-panel" aria-label={title}>
      <div className="section-heading">
        <div><span className="section-kicker">Returned data</span><h2>{title}</h2></div>
      </div>
      <div className="chart-canvas">
        <Line
          data={{
            labels,
            datasets: [{
              label: title,
              data: values,
              borderColor: "#d6a76d",
              backgroundColor: "rgba(214, 167, 109, 0.1)",
              fill: true,
              tension: 0.2,
              pointRadius: 3,
              pointBackgroundColor: "#d6a76d",
            }],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { intersect: false, mode: "index" } },
            scales: {
              y: { grid: { color: "#26332e" }, ticks: { color: "#a8b4ac" } },
              x: { grid: { display: false }, ticks: { color: "#a8b4ac" } },
            },
          }}
        />
      </div>
    </section>
  );
}
