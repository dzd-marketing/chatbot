import OrderedMap from "orderedmap";
import {
  DOMParser,
  type MarkSpec,
  type Node as ProsemirrorNode,
  Schema,
} from "prosemirror-model";
import { schema } from "prosemirror-schema-basic";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useEffect, useRef } from "react";
import { documentSchema } from "@/lib/editor/config";
import { DiffType, diffEditor } from "@/lib/editor/diff";
import { markdownToDom } from "@/lib/editor/functions";

const diffSchema = new Schema({
  marks: OrderedMap.from({
    ...schema.spec.marks.toObject(),
    diffMark: {
      attrs: { type: { default: "" } },
      toDOM(mark) {
        let className = "";

        switch (mark.attrs.type) {
          case DiffType.Inserted:
            className =
              "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 rounded-sm px-0.5 -mx-0.5";
            break;
          case DiffType.Deleted:
            className =
              "bg-red-500/15 line-through text-red-600 dark:text-red-400 rounded-sm px-0.5 -mx-0.5 opacity-70";
            break;
          default:
            className = "";
        }
        return ["span", { class: className }, 0];
      },
    } as MarkSpec,
  }),
  // Same nodes as the editor (lists, maths, tables).
  nodes: documentSchema.spec.nodes,
});

function computeDiff(oldDoc: ProsemirrorNode, newDoc: ProsemirrorNode) {
  return diffEditor(diffSchema, oldDoc.toJSON(), newDoc.toJSON());
}

type DiffEditorProps = {
  oldContent: string;
  newContent: string;
};

export const DiffView = ({ oldContent, newContent }: DiffEditorProps) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (editorRef.current && !viewRef.current) {
      const parser = DOMParser.fromSchema(diffSchema);

      const oldDoc = parser.parse(markdownToDom(oldContent));
      const newDoc = parser.parse(markdownToDom(newContent));

      const diffedDoc = computeDiff(oldDoc, newDoc);

      const state = EditorState.create({
        doc: diffedDoc,
        plugins: [],
      });

      viewRef.current = new EditorView(editorRef.current, {
        editable: () => false,
        state,
      });

      requestAnimationFrame(() => {
        const firstDiff = editorRef.current?.querySelector(
          "[class*='bg-emerald'], [class*='bg-red']"
        );
        if (firstDiff) {
          firstDiff.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [oldContent, newContent]);

  return (
    <div
      className="diff-editor prose dark:prose-invert prose-neutral relative max-w-none"
      ref={editorRef}
    />
  );
};
