import {
	CREATURE_BODY_TYPES,
	CREATURE_PALETTE,
	CREATURE_PARAM_BOUNDS,
	type CreatureParams,
	clearCreatureCache,
	earAngleFromDeg,
	earAngleToDeg,
	generateCreatureParams,
} from "@herzies/shared";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Herzie3D } from "./components/Herzie3D";

const WEARABLE_OPTIONS = ["headphones"];

const DEFAULT_USER = "sandbox-user";

function Sandbox() {
	const [userId, setUserId] = useState(DEFAULT_USER);
	const [params, setParams] = useState<CreatureParams>(() =>
		generateCreatureParams(DEFAULT_USER),
	);
	const [stage, setStage] = useState(1);
	const [size, setSize] = useState(5);
	const [animate, setAnimate] = useState(false);
	const [isPlaying, setIsPlaying] = useState(false);
	const [draggable, setDraggable] = useState(true);
	const [showSky, setShowSky] = useState(false);
	const [wearables, setWearables] = useState<string[]>([]);
	const [jsonOpen, setJsonOpen] = useState(false);

	const applySeed = useCallback((id: string) => {
		setParams(generateCreatureParams(id));
		clearCreatureCache();
	}, []);

	useEffect(() => {
		applySeed(userId);
	}, [userId, applySeed]);

	const patch = (partial: Partial<CreatureParams>) => {
		setParams((p) => ({ ...p, ...partial }));
		clearCreatureCache();
	};

	const toggleWearable = (id: string) => {
		setWearables((prev) =>
			prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id],
		);
		clearCreatureCache();
	};

	const randomUserId = () => {
		const id = `user-${Math.random().toString(36).slice(2, 10)}`;
		setUserId(id);
	};

	const copyJson = async () => {
		await navigator.clipboard.writeText(
			JSON.stringify({ userId, stage, creatureParams: params }, null, 2),
		);
	};

	return (
		<div style={{ display: "flex", minHeight: "100vh" }}>
			<aside
				style={{
					width: 320,
					flexShrink: 0,
					overflowY: "auto",
					maxHeight: "100vh",
					position: "sticky",
					top: 0,
					padding: 12,
					background: "#0a0a0f",
					borderRight: "1px solid #333",
					fontSize: 11,
				}}
			>
				<h1 style={{ fontSize: 13, color: "#c77dff", marginBottom: 12 }}>
					herzie sandbox
				</h1>

				<Section title="identity">
					<Field label="userId (seed)">
						<input
							value={userId}
							onChange={(e) => setUserId(e.target.value)}
							style={inputStyle}
						/>
					</Field>
					<div
						style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}
					>
						<Btn onClick={() => applySeed(userId)}>re-seed</Btn>
						<Btn onClick={randomUserId}>random id</Btn>
					</div>
				</Section>

				<Section title="body">
					<SelectField
						label="body type"
						value={params.bodyType}
						options={CREATURE_BODY_TYPES.map((t: string, i: number) => ({
							value: i,
							label: t,
						}))}
						onChange={(v) => patch({ bodyType: v })}
					/>
					<SliderField
						label="stage"
						value={stage}
						bounds={{ min: 1, max: 3, step: 1 }}
						onChange={(v) => {
							setStage(v);
							clearCreatureCache();
						}}
					/>
					<SliderField
						label="body scale"
						value={params.bodyScale}
						bounds={CREATURE_PARAM_BOUNDS.bodyScale}
						onChange={(v) => patch({ bodyScale: v })}
					/>
					<SliderField
						label="head ratio"
						value={params.headRatio}
						bounds={CREATURE_PARAM_BOUNDS.headRatio}
						onChange={(v) => patch({ headRatio: v })}
					/>
					<SelectField
						label="texture"
						value={params.textureType}
						options={[0, 1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
						onChange={(v) => patch({ textureType: v })}
					/>
				</Section>

				<Section title="color">
					<SelectField
						label="palette"
						value={params.colorIndex}
						options={CREATURE_PALETTE.map((hex: string, i: number) => ({
							value: i,
							label: hex,
							swatch: hex,
						}))}
						onChange={(v) => patch({ colorIndex: v })}
					/>
				</Section>

				<Section title="face">
					<SliderField
						label="eye spacing"
						value={params.eyeSpacing}
						bounds={CREATURE_PARAM_BOUNDS.eyeSpacing}
						onChange={(v) => patch({ eyeSpacing: v })}
					/>
					<SliderField
						label="eye size"
						value={params.eyeSize}
						bounds={CREATURE_PARAM_BOUNDS.eyeSize}
						onChange={(v) => patch({ eyeSize: v })}
					/>
					<SliderField
						label="eye height"
						value={params.eyeHeight}
						bounds={CREATURE_PARAM_BOUNDS.eyeHeight}
						onChange={(v) => patch({ eyeHeight: v })}
					/>
					<SelectField
						label="ears"
						value={params.earCount}
						options={[
							{ value: 0, label: "none" },
							{ value: 1, label: "1" },
							{ value: 2, label: "2" },
						]}
						onChange={(v) => patch({ earCount: v })}
					/>
					{params.earCount > 0 && (
						<>
							<SliderField
								label="ear angle (°)"
								value={earAngleToDeg(params.earAngle)}
								bounds={CREATURE_PARAM_BOUNDS.earAngleDeg}
								onChange={(v) => patch({ earAngle: earAngleFromDeg(v) })}
							/>
							<SliderField
								label="ear length"
								value={params.earLength}
								bounds={CREATURE_PARAM_BOUNDS.earLength}
								onChange={(v) => patch({ earLength: v })}
							/>
						</>
					)}
				</Section>

				<Section title="limbs">
					<SliderField
						label="arm length"
						value={params.armLength}
						bounds={CREATURE_PARAM_BOUNDS.armLength}
						onChange={(v) => patch({ armLength: v })}
					/>
					<SliderField
						label="leg length"
						value={params.legLength}
						bounds={CREATURE_PARAM_BOUNDS.legLength}
						onChange={(v) => patch({ legLength: v })}
					/>
				</Section>

				<Section title="display">
					<SliderField
						label="size (px)"
						value={size}
						bounds={{ min: 2, max: 20, step: 1 }}
						onChange={setSize}
					/>
					<Check
						label="animate (rotate)"
						checked={animate}
						onChange={setAnimate}
					/>
					<Check
						label="isPlaying (dance)"
						checked={isPlaying}
						onChange={setIsPlaying}
					/>
					<Check
						label="draggable"
						checked={draggable}
						onChange={setDraggable}
					/>
					<Check label="show sky" checked={showSky} onChange={setShowSky} />
					<div style={{ marginTop: 8 }}>
						wearables:
						{WEARABLE_OPTIONS.map((w) => (
							<Check
								key={w}
								label={w}
								checked={wearables.includes(w)}
								onChange={() => toggleWearable(w)}
							/>
						))}
					</div>
				</Section>

				<div
					style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}
				>
					<Btn onClick={() => setJsonOpen((v) => !v)}>
						{jsonOpen ? "hide json" : "show json"}
					</Btn>
					<Btn onClick={copyJson}>copy json</Btn>
				</div>

				{jsonOpen && (
					<pre
						style={{
							marginTop: 8,
							padding: 8,
							background: "#111",
							border: "1px solid #333",
							borderRadius: 4,
							fontSize: 10,
							overflow: "auto",
							maxHeight: 200,
							color: "#aaa",
						}}
					>
						{JSON.stringify({ userId, stage, creatureParams: params }, null, 2)}
					</pre>
				)}
			</aside>

			<main
				style={{
					flex: 1,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: 24,
					minHeight: "100vh",
				}}
			>
				<Herzie3D
					userId={userId}
					stage={stage}
					size={size}
					animate={animate}
					isPlaying={isPlaying}
					wearables={wearables}
					creatureParams={params}
					showSky={showSky}
					draggable={draggable}
				/>
			</main>
		</div>
	);
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div style={{ marginBottom: 16 }}>
			<h2
				style={{
					fontSize: 10,
					textTransform: "uppercase",
					letterSpacing: "0.08em",
					color: "#7ec8e3",
					marginBottom: 8,
				}}
			>
				{title}
			</h2>
			{children}
		</div>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div style={{ marginBottom: 8 }}>
			<span style={{ color: "#6a6a7a", display: "block", marginBottom: 2 }}>
				{label}
			</span>
			{children}
		</div>
	);
}

function SliderField({
	label,
	value,
	bounds,
	onChange,
}: {
	label: string;
	value: number;
	bounds: { min: number; max: number; step: number };
	onChange: (v: number) => void;
}) {
	const decimals = bounds.step < 1 ? 3 : 0;
	return (
		<Field label={`${label}: ${value.toFixed(decimals)}`}>
			<input
				type="range"
				min={bounds.min}
				max={bounds.max}
				step={bounds.step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				style={{ width: "100%" }}
			/>
		</Field>
	);
}

function SelectField({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: number;
	options: { value: number; label: string; swatch?: string }[];
	onChange: (v: number) => void;
}) {
	return (
		<Field label={label}>
			<select
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				style={inputStyle}
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.swatch ? `■ ${o.label}` : o.label}
					</option>
				))}
			</select>
			{options[value]?.swatch && (
				<span
					style={{
						display: "inline-block",
						width: 14,
						height: 14,
						marginLeft: 8,
						verticalAlign: "middle",
						background: options[value].swatch,
						border: "1px solid #444",
					}}
				/>
			)}
		</Field>
	);
}

function Check({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label style={{ display: "block", marginTop: 4, cursor: "pointer" }}>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
			/>{" "}
			{label}
		</label>
	);
}

function Btn({
	children,
	onClick,
}: {
	children: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				background: "#1a1a2e",
				color: "#c77dff",
				border: "1px solid #444",
				padding: "4px 8px",
				fontSize: 11,
				cursor: "pointer",
				borderRadius: 4,
				fontFamily: "inherit",
			}}
		>
			{children}
		</button>
	);
}

const inputStyle: React.CSSProperties = {
	width: "100%",
	background: "#222",
	color: "#e0e0e0",
	border: "1px solid #444",
	padding: "4px 6px",
	fontFamily: "inherit",
	fontSize: 11,
	boxSizing: "border-box",
};

const root = createRoot(document.getElementById("root")!);
root.render(<Sandbox />);
