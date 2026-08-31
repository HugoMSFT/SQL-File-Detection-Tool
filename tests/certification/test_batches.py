"""GO is a client directive, not T-SQL. Splitting it wrong is how a harness
ends up either sending a batch twice or sending a comment as a statement.
"""

from certification.batches import mask_sql, split_batches, strip_sql_comments


def test_splits_on_go_and_numbers_batches():
    batches = split_batches('SELECT 1;\nGO\nSELECT 2;\nGO\n')
    assert [b.index for b in batches] == [0, 1]
    assert [b.text.strip() for b in batches] == ['SELECT 1;', 'SELECT 2;']


def test_records_go_repeat_counts():
    batches = split_batches('SELECT 1;\nGO 3\n')
    assert batches[0].repeat == 3


def test_go_inside_a_string_or_identifier_is_not_a_separator():
    sql = "SELECT 'line\nGO\nmore';"
    assert len(split_batches(sql)) == 1
    assert len(split_batches('SELECT [a\nGO\nb] FROM t;')) == 1


def test_go_must_stand_alone_on_its_line():
    assert len(split_batches('SELECT 1;\nGOTO x\n')) == 1


def test_trailing_batch_without_go_is_kept():
    batches = split_batches('SELECT 1;\nGO\nSELECT 2;')
    assert len(batches) == 2
    assert batches[1].text.strip() == 'SELECT 2;'


def test_empty_and_comment_only_batches_are_dropped():
    assert split_batches('\n\nGO\n\n') == []
    assert split_batches('-- just a note\nGO\n') == []


def test_start_line_points_at_the_original_source():
    batches = split_batches('SELECT 1;\nGO\n\n\nSELECT 2;\n')
    assert batches[1].start_line == 3


def test_mask_sql_preserves_offsets_and_newlines():
    sql = "SELECT 'secret'\n-- note\nFROM t;"
    masked = mask_sql(sql)
    assert len(masked) == len(sql)
    assert masked.count('\n') == sql.count('\n')
    assert 'secret' not in masked
    assert 'note' not in masked
    assert 'FROM t;' in masked


def test_mask_sql_keeps_bracketed_identifiers_visible():
    # The gate has to be able to read [dbo].[orders] to refuse it.
    assert '[dbo].[orders]' in mask_sql('SELECT * FROM [dbo].[orders];')


def test_mask_strings_false_keeps_literals_but_drops_comments():
    sql = "-- see <docs>\nBULK INSERT x FROM '<path>';"
    masked = mask_sql(sql, mask_strings=False)
    assert '<path>' in masked
    assert '<docs>' not in masked


def test_strip_sql_comments_removes_both_comment_styles():
    stripped = strip_sql_comments('SELECT 1; -- a\n/* b\nc */ SELECT 2;')
    assert 'a' not in stripped
    assert 'b' not in stripped
    assert 'SELECT 1;' in stripped and 'SELECT 2;' in stripped


def test_escaped_right_bracket_does_not_desync_the_masker():
    """A doubled ]] is part of the name, not the end of it.

    Getting this wrong is not cosmetic: the masker would treat the rest of the
    identifier as code, hit the stray quote inside it, decide a string literal
    had started, and blank the remainder of the batch. Everything downstream --
    the GO split and every safety scan -- then reads text the server would
    never see.
    """
    sql = "SELECT [a]]'b] FROM [t];"
    masked = mask_sql(sql, mask_identifiers=True)
    assert masked.endswith('FROM [ ];')
    assert masked.startswith('SELECT [')
    assert "'" not in masked


def test_escaped_right_bracket_does_not_hide_a_go_boundary():
    script = "SELECT [a]]'b];\nGO\nDROP TABLE [dbo].[orders];\n"
    batches = split_batches(script)
    assert len(batches) == 2
    assert 'DROP TABLE' in batches[1].text
